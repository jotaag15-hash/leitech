import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const codePepper = Deno.env.get('RECOVERY_CODE_PEPPER');
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

if (!supabaseUrl || !serviceRoleKey || !codePepper || codePepper.length < 32 || allowedOrigins.length === 0) {
    throw new Error('Missing required Supabase recovery function configuration.');
}

const whatsappAccessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN');
const whatsappPhoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID');
const whatsappTemplateName = Deno.env.get('WHATSAPP_TEMPLATE_NAME');
const whatsappTemplateLanguage = Deno.env.get('WHATSAPP_TEMPLATE_LANGUAGE');
const whatsappGraphApiVersion = Deno.env.get('WHATSAPP_GRAPH_API_VERSION');
const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});
const encoder = new TextEncoder();

function corsHeaders(origin: string) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Vary': 'Origin'
    };
}

function jsonResponse(body: Record<string, string>, status: number, origin: string) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
    });
}

function normalizePhone(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let digits = value.replace(/\D/g, '');
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
        digits = digits.slice(2);
    }
    return /^\d{10,11}$/.test(digits) ? digits : null;
}

function isRequestBody(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function generateCode(): string {
    const value = new Uint32Array(1);
    const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
    do {
        crypto.getRandomValues(value);
    } while (value[0] >= limit);
    return String(value[0] % 1_000_000).padStart(6, '0');
}

async function hashCode(phone: string, code: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(codePepper),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(`${phone}:${code}`));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sendWhatsAppCode(phone: string, code: string): Promise<void> {
    if (!whatsappAccessToken || !whatsappPhoneNumberId || !whatsappTemplateName ||
        !whatsappTemplateLanguage || !whatsappGraphApiVersion) {
        throw new Error('WhatsApp Cloud API settings are incomplete.');
    }

    const response = await fetch(
        `https://graph.facebook.com/${encodeURIComponent(whatsappGraphApiVersion)}/${encodeURIComponent(whatsappPhoneNumberId)}/messages`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${whatsappAccessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: `55${phone}`,
                type: 'template',
                template: {
                    name: whatsappTemplateName,
                    language: { code: whatsappTemplateLanguage },
                    components: [
                        {
                            type: 'body',
                            parameters: [{ type: 'text', text: code }]
                        },
                        {
                            type: 'button',
                            sub_type: 'url',
                            index: '0',
                            parameters: [{ type: 'text', text: code }]
                        }
                    ]
                }
            })
        }
    );

    if (!response.ok) {
        throw new Error(`WhatsApp message delivery failed (${response.status}).`);
    }
}

function hasWhatsAppConfiguration(): boolean {
    return Boolean(
        whatsappAccessToken &&
        whatsappPhoneNumberId &&
        whatsappTemplateName &&
        whatsappTemplateLanguage &&
        whatsappGraphApiVersion
    );
}

Deno.serve(async (request) => {
    const requestOrigin = request.headers.get('Origin') ?? '';
    if (!allowedOrigins.includes(requestOrigin)) {
        return new Response('Origin not allowed.', { status: 403 });
    }
    if (request.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders(requestOrigin) });
    }
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed.' }, 405, requestOrigin);
    }

    try {
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: 'Solicitação inválida.' }, 400, requestOrigin);
        }
        if (!isRequestBody(body)) {
            return jsonResponse({ error: 'Solicitação inválida.' }, 400, requestOrigin);
        }
        const phone = normalizePhone(body.phone);
        if (!phone) {
            return jsonResponse({ error: 'Informe um telefone válido com DDD.' }, 400, requestOrigin);
        }

        if (body.action === 'request') {
            if (!hasWhatsAppConfiguration()) {
                return jsonResponse({
                    error: 'A recuperação por WhatsApp ainda não foi configurada.'
                }, 503, requestOrigin);
            }

            const code = generateCode();
            const { data: userId, error } = await supabase.rpc('issue_whatsapp_password_recovery', {
                p_phone: phone,
                p_code_hash: await hashCode(phone, code),
                p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                p_now: new Date().toISOString()
            });
            if (error) throw error;

            if (userId) {
                try {
                    await sendWhatsAppCode(phone, code);
                } catch (error) {
                    console.error('WhatsApp recovery code delivery failed:', error);
                }
            }
            return jsonResponse({
                message: 'Se o número estiver cadastrado, você receberá um código pelo WhatsApp.'
            }, 200, requestOrigin);
        }

        if (body.action === 'complete') {
            if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code) ||
                typeof body.password !== 'string' || !/^[a-zA-Z0-9]{8}$/.test(body.password)) {
                return jsonResponse({ error: 'Código ou senha inválidos.' }, 400, requestOrigin);
            }

            const { data: userId, error } = await supabase.rpc('consume_whatsapp_password_recovery', {
                p_phone: phone,
                p_code_hash: await hashCode(phone, body.code),
                p_now: new Date().toISOString()
            });
            if (error) throw error;
            if (!userId) {
                return jsonResponse({ error: 'Código inválido, expirado ou já utilizado.' }, 400, requestOrigin);
            }

            const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
                password: body.password
            });
            if (updateError) throw updateError;
            return jsonResponse({ message: 'Senha atualizada com sucesso.' }, 200, requestOrigin);
        }

        return jsonResponse({ error: 'Ação de recuperação inválida.' }, 400, requestOrigin);
    } catch (error) {
        console.error('WhatsApp password recovery request failed:', error);
        return jsonResponse({
            error: 'Não foi possível concluir a solicitação. Tente novamente mais tarde.'
        }, 500, requestOrigin);
    }
});
