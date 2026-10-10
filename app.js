// ==========================================
// LeiTech - Gestão de Produtores de Leite
// State Management & Application Logic
// ==========================================

let supabaseClient;
let currentUser = null;
let loadedUserId = null;
let loadingUserId = null;
let isAdmin = false;
let sharedDataChannel = null;
let sharedDataRefreshTimer = null;
let producers = [];
let deliveries = [];
function normalizeSettings(value = {}) {
    const normalized = {
        defaultPrice: '',
        companyName: 'LeiTech - Gestão de Leite',
        dairyName: '',
        ...value
    };

    if (!normalized.dairyName && !['LeiTech', 'LeiTech - Gestão de Leite'].includes(normalized.companyName)) {
        normalized.dairyName = normalized.companyName;
    }

    return normalized;
}

let settings = normalizeSettings();
let appUnlocked = false;

// Receipt State
let currentReceiptFormat = 'text'; // 'text' | 'image' | 'pdf'
let activeReceiptMeta = {
    title: 'Comprovante',
    fileName: 'comprovante',
    type: 'delivery',
    data: null
};

// DOM Elements
const sections = document.querySelectorAll('.section');
const navItems = document.querySelectorAll('.nav-item');

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    // Set default dates
    const deliveryDate = document.getElementById('delivery-date');
    if (deliveryDate) deliveryDate.valueAsDate = new Date();

    const reportMonth = document.getElementById('report-month');
    if (reportMonth) reportMonth.value = new Date().toISOString().slice(0, 7);

    const reportDate = document.getElementById('report-date');
    if (reportDate) reportDate.valueAsDate = new Date();

    // Start App Directly
    setupEventListeners();
    setupAuthenticationForms();
    initializeAppAccess();
});

function setupEventListeners() {
    // Navigation
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const sectionId = item.getAttribute('data-section');
            if (sectionId) {
                showSection(sectionId);
                const sidebar = document.getElementById('app-sidebar');
                if (sidebar && sidebar.classList.contains('open')) {
                    toggleSidebar();
                }
            }
        });
    });

    // Producer Form
    const prodForm = document.getElementById('producer-form');
    if (prodForm) {
        prodForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('prod-name').value.trim();
            const property = document.getElementById('prod-property').value.trim();
            const phone = document.getElementById('prod-phone').value.trim();

            if (!name) {
                showToast('Informe o nome do produtor!', 'error');
                return;
            }

            const newProducer = {
                id: createRecordId(),
                name,
                property,
                phone
            };

            const { data, error } = await supabaseClient
                .from('producers')
                .insert(newProducer)
                .select('id, name, property, phone')
                .single();
            if (error) {
                showToast(`Erro ao salvar produtor: ${error.message}`, 'error');
                return;
            }

            producers.push(mapProducer(data));
            renderProducers();
            populateSelects();
            updateDashboard();
            prodForm.reset();
            showToast(`Produtor "${name}" cadastrado com sucesso!`, 'success');
        });
    }

    const dairyForm = document.getElementById('dairy-form');
    if (dairyForm) {
        dairyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const dairyName = document.getElementById('dairy-name').value.trim();
            if (!dairyName) {
                showToast('Informe o nome do laticínio!', 'error');
                return;
            }

            const updatedSettings = { ...settings, dairyName, companyName: dairyName };
            try {
                await persistSharedSettings(updatedSettings);
            } catch (error) {
                showToast(`Erro ao salvar laticínio: ${error.message}`, 'error');
                return;
            }
            settings = updatedSettings;
            updateReportDairy();
            showToast('Laticínio salvo com sucesso!', 'success');
        });
    }

    // Delivery Form
    const deliveryForm = document.getElementById('delivery-form');
    if (deliveryForm) {
        deliveryForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const producerId = document.getElementById('delivery-producer').value;
            const date = document.getElementById('delivery-date').value;
            const liters = parseFloat(document.getElementById('delivery-liters').value);
            const price = parseFloat(document.getElementById('delivery-price').value);

            if (!producerId) {
                showToast('Selecione um produtor!', 'error');
                return;
            }
            if (isNaN(liters) || liters <= 0) {
                showToast('Informe uma quantidade de litros válida!', 'error');
                return;
            }
            if (isNaN(price) || price < 0) {
                showToast('Informe um valor por litro válido!', 'error');
                return;
            }

            const newDelivery = {
                id: createRecordId(),
                producerId,
                date,
                liters,
                price
            };

            // Save last used price as default if empty
            if (!settings.defaultPrice) {
                const updatedSettings = { ...settings, defaultPrice: price.toString() };
                try {
                    await persistSharedSettings(updatedSettings);
                    settings = updatedSettings;
                } catch (error) {
                    showToast(`Entrega não foi salva porque o preço padrão não pôde ser atualizado: ${error.message}`, 'error');
                    return;
                }
            }

            const { data, error } = await supabaseClient
                .from('deliveries')
                .insert({
                    id: newDelivery.id,
                    producer_id: newDelivery.producerId,
                    date: newDelivery.date,
                    liters: newDelivery.liters,
                    price: newDelivery.price
                })
                .select('id, producer_id, date, liters, price')
                .single();
            if (error) {
                showToast(`Erro ao salvar entrega: ${error.message}`, 'error');
                return;
            }

            deliveries.push(mapDelivery(data));
            renderDeliveries();
            renderFortnightSummary();
            updateDashboard();

            const prod = producers.find(p => p.id === producerId);
            showToast(`Entrega de ${liters.toFixed(1)} L registrada para ${prod ? prod.name : 'produtor'}!`, 'success');

            // Reset liters input and preserve price & today date
            document.getElementById('delivery-liters').value = '';
            document.getElementById('delivery-date').valueAsDate = new Date();
        });
    }

    // Phone input auto formatting
    ['prod-phone', 'edit-prod-phone', 'receipt-phone'].forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', (e) => {
                let v = e.target.value.replace(/\D/g, '');
                if (v.length > 11) v = v.slice(0, 11);
                if (v.length > 10) {
                    e.target.value = `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
                } else if (v.length > 6) {
                    e.target.value = `(${v.slice(0, 2)}) ${v.slice(2, 6)}-${v.slice(6)}`;
                } else if (v.length > 2) {
                    e.target.value = `(${v.slice(0, 2)}) ${v.slice(2)}`;
                } else if (v.length > 0) {
                    e.target.value = `(${v}`;
                }
            });
        }
    });
}

function setupAuthenticationForms() {
    const authEmail = document.getElementById('auth-email');
    const authPassword = document.getElementById('auth-password');
    const resetRequested = new URLSearchParams(window.location.search).has('recovery');
    const inviteAccepted = new URLSearchParams(window.location.search).has('invite');

    if (resetRequested || inviteAccepted) showPasswordUpdateForm();
    if (authEmail) authEmail.focus();
    if (authPassword) {
        authPassword.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') document.getElementById('app-auth-form')?.requestSubmit();
        });
    }
}

function showPasswordUpdateForm() {
    const loginForm = document.getElementById('app-auth-form');
    const updateForm = document.getElementById('auth-password-update-form');
    const resetButton = document.getElementById('auth-reset-password');
    if (loginForm) loginForm.hidden = true;
    if (updateForm) updateForm.hidden = false;
    if (resetButton) resetButton.hidden = true;
    const title = document.querySelector('#app-auth-modal .modal-header h3');
    if (title) title.innerText = 'Definir nova senha';
}

function showSignInForm() {
    const loginForm = document.getElementById('app-auth-form');
    const updateForm = document.getElementById('auth-password-update-form');
    const resetButton = document.getElementById('auth-reset-password');
    if (loginForm) loginForm.hidden = false;
    if (updateForm) updateForm.hidden = true;
    if (resetButton) resetButton.hidden = false;
    const title = document.querySelector('#app-auth-modal .modal-header h3');
    if (title) title.innerText = 'Acesso ao Sistema';
}

function authRedirectUrl(flow) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set(flow, '1');
    return url.toString();
}

async function signInToApp(event) {
    event.preventDefault();
    if (!supabaseClient) {
        showToast('O Supabase não está conectado. Verifique a configuração e a conexão com a internet.', 'error');
        return;
    }

    const email = document.getElementById('auth-email').value.trim().toLowerCase();
    const password = document.getElementById('auth-password').value;
    try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            showToast(`Não foi possível entrar: ${error.message}`, 'error');
            return;
        }
        document.getElementById('auth-password').value = '';
    } catch (error) {
        showToast(`Não foi possível entrar: ${error.message}`, 'error');
    }
}

async function requestPasswordReset() {
    if (!supabaseClient) {
        showToast('O Supabase não está conectado. Verifique a configuração e a conexão com a internet.', 'error');
        return;
    }
    const email = document.getElementById('auth-email').value.trim().toLowerCase();
    if (!email) {
        showToast('Informe seu e-mail para receber o link de recuperação.', 'error');
        document.getElementById('auth-email').focus();
        return;
    }

    try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: authRedirectUrl('recovery')
        });
        if (error) {
            showToast(`Não foi possível enviar o link: ${error.message}`, 'error');
            return;
        }
        showToast('Se o e-mail estiver cadastrado, você receberá o link para redefinir a senha.', 'success');
    } catch (error) {
        showToast(`Não foi possível enviar o link: ${error.message}`, 'error');
    }
}

async function updateAccountPassword(event) {
    event.preventDefault();
    if (!supabaseClient) {
        showToast('O Supabase não está conectado. Verifique a configuração e a conexão com a internet.', 'error');
        return;
    }

    const password = document.getElementById('auth-new-password').value;
    const confirmation = document.getElementById('auth-confirm-password').value;
    if (password.length < 8) {
        showToast('A senha deve ter pelo menos 8 caracteres.', 'error');
        return;
    }
    if (password !== confirmation) {
        showToast('As senhas não coincidem.', 'error');
        return;
    }

    try {
        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) {
            showToast(`Não foi possível atualizar a senha: ${error.message}`, 'error');
            return;
        }

        window.history.replaceState({}, document.title, window.location.pathname);
        document.getElementById('auth-password-update-form').reset();
        showSignInForm();
        showToast('Senha atualizada. Você já pode acessar o sistema.', 'success');
    } catch (error) {
        showToast(`Não foi possível atualizar a senha: ${error.message}`, 'error');
    }
}

async function initializeAppAccess() {
    const config = window.LEITECH_SUPABASE_CONFIG;
    if (!config?.url || !config?.publishableKey || !window.supabase?.createClient) {
        showToast('Configuração Supabase ausente. Verifique supabase-config.js e a conexão.', 'error');
        return;
    }

    supabaseClient = window.supabase.createClient(config.url, config.publishableKey, {
        auth: {
            autoRefreshToken: true,
            detectSessionInUrl: true,
            persistSession: true,
            flowType: 'pkce'
        }
    });

    supabaseClient.auth.onAuthStateChange((event, session) => {
        setTimeout(() => handleAuthSession(event, session), 0);
    });

    const { data, error } = await supabaseClient.auth.getSession();
    if (error) {
        showToast(`Erro ao recuperar a sessão: ${error.message}`, 'error');
        openModal('app-auth-modal');
        return;
    }
    await handleAuthSession('INITIAL_SESSION', data.session);
}

async function handleAuthSession(event, session) {
    currentUser = session?.user || null;
    appUnlocked = Boolean(currentUser);

    if (!currentUser) {
        if (sharedDataChannel) {
            await supabaseClient.removeChannel(sharedDataChannel);
            sharedDataChannel = null;
        }
        window.removeEventListener('focus', refreshSharedData);
        loadedUserId = null;
        loadingUserId = null;
        isAdmin = false;
        const settingsNav = document.getElementById('settings-nav-item');
        if (settingsNav) settingsNav.hidden = true;
        const dairyNav = document.getElementById('dairy-nav-item');
        if (dairyNav) dairyNav.hidden = true;
        producers = [];
        deliveries = [];
        settings = normalizeSettings();
        updateDashboard();
        renderProducers();
        renderDeliveries();
        populateSelects();
        showSignInForm();
        openModal('app-auth-modal');
        return;
    }

    closeModal('app-auth-modal');
    if (event === 'PASSWORD_RECOVERY' ||
        new URLSearchParams(window.location.search).has('recovery') ||
        new URLSearchParams(window.location.search).has('invite')) {
        showPasswordUpdateForm();
        openModal('app-auth-modal');
        return;
    }

    const userId = currentUser.id;
    if (loadedUserId === userId) return;
    if (loadingUserId === userId) return;
    loadingUserId = userId;

    try {
        await loadSharedData();
        if (currentUser?.id !== userId) return;
        loadedUserId = userId;
        const settingsNav = document.getElementById('settings-nav-item');
        if (settingsNav) settingsNav.hidden = !isAdmin;
        const dairyNav = document.getElementById('dairy-nav-item');
        if (dairyNav) dairyNav.hidden = !isAdmin;
        showSection('dashboard');
        showToast('Acesso liberado ao LeiTech.', 'success');
        subscribeToSharedData();
        window.addEventListener('focus', refreshSharedData);
    } catch (error) {
        console.error('Supabase data load failed:', error);
        appUnlocked = false;
        showToast(`Não foi possível carregar os dados: ${error.message}. Confira o schema e a autorização do usuário no Supabase.`, 'error');
        await supabaseClient.auth.signOut();
    } finally {
        if (loadingUserId === userId) loadingUserId = null;
    }
}

function mapProducer(row) {
    return {
        id: row.id,
        name: row.name,
        property: row.property || '',
        phone: row.phone || ''
    };
}

function mapDelivery(row) {
    return {
        id: row.id,
        producerId: row.producer_id || '',
        date: row.date,
        liters: Number(row.liters),
        price: Number(row.price)
    };
}

async function loadSharedData() {
    const [authorizationResult, adminResult, producerResult, deliveryResult, settingsResult] = await Promise.all([
        supabaseClient.rpc('is_authorized_user'),
        supabaseClient.rpc('is_admin_user'),
        supabaseClient.from('producers').select('id, name, property, phone').order('name'),
        supabaseClient.from('deliveries').select('id, producer_id, date, liters, price').order('date', { ascending: false }),
        supabaseClient.from('app_settings').select('default_price, dairy_name, company_name').eq('id', 1).maybeSingle()
    ]);

    if (authorizationResult.error) throw authorizationResult.error;
    if (authorizationResult.data !== true) {
        throw new Error('Este e-mail não está autorizado. Peça ao administrador para incluí-lo na lista e enviar o convite.');
    }
    if (adminResult.error) throw adminResult.error;
    if (producerResult.error) throw producerResult.error;
    if (deliveryResult.error) throw deliveryResult.error;
    if (settingsResult.error) throw settingsResult.error;

    producers = producerResult.data.map(mapProducer);
    deliveries = deliveryResult.data.map(mapDelivery);
    isAdmin = adminResult.data === true;
    if (settingsResult.data) {
        settings = normalizeSettings({
            defaultPrice: settingsResult.data.default_price,
            dairyName: settingsResult.data.dairy_name,
            companyName: settingsResult.data.company_name
        });
    } else {
        settings = normalizeSettings();
    }

    loadPreferences();
    updateReportDairy();
    updateDashboard();
    renderProducers();
    renderDeliveries();
    renderFortnightSummary();
    populateSelects();
}

function createRecordId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function persistSharedSettings(nextSettings) {
    const { error } = await supabaseClient.rpc('save_shared_settings', {
        p_default_price: nextSettings.defaultPrice || '',
        p_dairy_name: nextSettings.dairyName || '',
        p_company_name: nextSettings.companyName || 'LeiTech - Gestão de Leite'
    });
    if (error) throw error;
}

function subscribeToSharedData() {
    if (!supabaseClient || sharedDataChannel) return;
    sharedDataChannel = supabaseClient
        .channel('leitech-shared-data')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'producers' }, scheduleSharedDataRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, scheduleSharedDataRefresh)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, scheduleSharedDataRefresh)
        .subscribe((status) => {
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                console.error(`Supabase realtime subscription failed: ${status}`);
            }
        });
}

function scheduleSharedDataRefresh() {
    clearTimeout(sharedDataRefreshTimer);
    sharedDataRefreshTimer = setTimeout(refreshSharedData, 250);
}

async function refreshSharedData() {
    if (!currentUser || !supabaseClient) return;
    try {
        await loadSharedData();
    } catch (error) {
        console.error('Supabase data refresh failed:', error);
        showToast(`Erro ao atualizar dados compartilhados: ${error.message}`, 'error');
    }
}

async function logoutApp() {
    if (!supabaseClient) {
        showToast('O Supabase não está conectado. Não foi possível encerrar a sessão.', 'error');
        return;
    }
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
            showToast(`Não foi possível encerrar a sessão: ${error.message}`, 'error');
            return;
        }
    } catch (error) {
        showToast(`Não foi possível encerrar a sessão: ${error.message}`, 'error');
        return;
    }
    if (sharedDataChannel) {
        await supabaseClient.removeChannel(sharedDataChannel);
        sharedDataChannel = null;
    }
    window.removeEventListener('focus', refreshSharedData);
    showToast('Sessão encerrada.', 'info');
}

function showSection(id) {
    if (!appUnlocked) {
        openModal('app-auth-modal');
        return;
    }
    if (['settings', 'dairy'].includes(id) && !isAdmin) {
        showToast('Apenas administradores podem acessar essas configurações.', 'error');
        return;
    }

    sections.forEach(s => s.classList.remove('active'));
    navItems.forEach(n => n.classList.remove('active'));

    const targetSection = document.getElementById(id);
    if (targetSection) targetSection.classList.add('active');

    const activeNav = document.querySelector(`[data-section="${id}"]`);
    if (activeNav) activeNav.classList.add('active');

    const titles = {
        dashboard: 'Página Inicial',
        producers: 'Produtores',
        deliveries: 'Entregas',
        reports: 'Relatórios',
        dairy: 'Laticínio',
        settings: 'Backup & Configurações'
    };
    const subtitles = {
        dashboard: 'Acompanhamento geral e métricas de coleta',
        producers: 'Gerencie os produtores cadastrados',
        deliveries: 'Registro e histórico de coletas de leite',
        reports: 'Emissão e exportação de relatórios detalhados',
        dairy: 'Cadastre o laticínio responsável pelas entregas',
        settings: 'Segurança dos dados e preferências do sistema'
    };

    if (titles[id]) document.getElementById('page-title').innerText = titles[id];
    if (subtitles[id]) document.getElementById('page-subtitle').innerText = subtitles[id];
}

function toggleSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (sidebar) sidebar.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('active');
}

// ----------------------------------------------------
// Producers Management
// ----------------------------------------------------

function renderProducers(filteredList = null) {
    const list = document.getElementById('producers-list');
    if (!list) return;
    const displayProducers = filteredList || producers;

    if (displayProducers.length === 0) {
        list.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhum produtor encontrado.</td></tr>`;
        return;
    }

    list.innerHTML = displayProducers.map(p => `
        <tr>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td>${escapeHtml(p.property || '-')}</td>
            <td>${p.phone ? `<span style="color: var(--primary); font-weight: 500;"><i data-lucide="phone" style="width: 14px; height: 14px; vertical-align: middle;"></i> ${escapeHtml(p.phone)}</span>` : '<span style="color: var(--text-muted);">-</span>'}</td>
            <td>
                <div class="actions-cell">
                    ${p.phone ? `
                        <button class="btn-icon whatsapp-icon" title="Enviar WhatsApp" onclick="openDirectWhatsApp('${p.phone}', '${escapeHtml(p.name)}')">
                            <i data-lucide="message-circle" style="width: 18px; height: 18px;"></i>
                        </button>
                    ` : ''}
                    <button class="btn-icon edit-icon" title="Editar Produtor" onclick="openEditProducerModal('${p.id}')">
                        <i data-lucide="edit" style="width: 18px; height: 18px;"></i>
                    </button>
                    <button class="btn-icon delete-icon" title="Excluir Produtor" onclick="deleteProducer('${p.id}')">
                        <i data-lucide="trash-2" style="width: 18px; height: 18px;"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

function filterProducers() {
    const term = document.getElementById('search-producers').value.toLowerCase().trim();
    if (!term) {
        renderProducers();
        return;
    }
    const filtered = producers.filter(p =>
        p.name.toLowerCase().includes(term) ||
        (p.property && p.property.toLowerCase().includes(term)) ||
        (p.phone && p.phone.includes(term))
    );
    renderProducers(filtered);
}

function openEditProducerModal(id) {
    const prod = producers.find(p => p.id === id);
    if (!prod) return;

    document.getElementById('edit-prod-id').value = prod.id;
    document.getElementById('edit-prod-name').value = prod.name;
    document.getElementById('edit-prod-property').value = prod.property || '';
    document.getElementById('edit-prod-phone').value = prod.phone || '';

    openModal('edit-producer-modal');
}

async function saveEditProducer(e) {
    e.preventDefault();
    const id = document.getElementById('edit-prod-id').value;
    const name = document.getElementById('edit-prod-name').value.trim();
    const property = document.getElementById('edit-prod-property').value.trim();
    const phone = document.getElementById('edit-prod-phone').value.trim();

    const index = producers.findIndex(p => p.id === id);
    if (index !== -1) {
        const { data, error } = await supabaseClient
            .from('producers')
            .update({ name, property, phone })
            .eq('id', id)
            .select('id, name, property, phone')
            .single();
        if (error) {
            showToast(`Erro ao atualizar produtor: ${error.message}`, 'error');
            return;
        }
        producers[index] = mapProducer(data);
        renderProducers();
        populateSelects();
        renderDeliveries();
        renderFortnightSummary();
        closeModal('edit-producer-modal');
        showToast(`Produtor "${name}" atualizado com sucesso!`, 'success');
    }
}

async function deleteProducer(id) {
    const prod = producers.find(p => p.id === id);
    const prodName = prod ? prod.name : 'este produtor';

    if (confirm(`Tem certeza que deseja excluir "${prodName}"? As entregas registradas não serão apagadas.`)) {
        const { error } = await supabaseClient.from('producers').delete().eq('id', id);
        if (error) {
            showToast(`Erro ao excluir produtor: ${error.message}`, 'error');
            return;
        }
        producers = producers.filter(p => p.id !== id);
        renderProducers();
        populateSelects();
        renderDeliveries();
        updateDashboard();
        showToast(`Produtor "${prodName}" excluído.`, 'info');
    }
}

// ----------------------------------------------------
// Deliveries Management
// ----------------------------------------------------

function renderDeliveries(filteredList = null) {
    const history = document.getElementById('deliveries-history');
    if (!history) return;
    const sorted = [...(filteredList || deliveries)].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (sorted.length === 0) {
        history.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhuma entrega encontrada.</td></tr>`;
    } else {
        history.innerHTML = sorted.map(d => {
            const prod = producers.find(p => p.id === d.producerId);
            const total = d.liters * (d.price || 0);
            return `
                <tr>
                    <td>${formatDate(d.date)}</td>
                    <td><strong>${prod ? escapeHtml(prod.name) : '<span style="color:red">Excluído</span>'}</strong></td>
                    <td>${d.liters.toFixed(2)} L</td>
                    <td>R$ ${(d.price || 0).toFixed(2)}</td>
                    <td><strong style="color: var(--primary-dark);">R$ ${total.toFixed(2)}</strong></td>
                    <td>
                        <div class="actions-cell">
                            <button class="btn-icon whatsapp-icon" title="Comprovante WhatsApp / Imagem / PDF" onclick="openReceiptModal('${d.id}')">
                                <i data-lucide="message-circle" style="width: 18px; height: 18px;"></i>
                            </button>
                            <button class="btn-icon edit-icon" title="Editar Entrega" onclick="openEditDeliveryModal('${d.id}')">
                                <i data-lucide="edit" style="width: 18px; height: 18px;"></i>
                            </button>
                            <button class="btn-icon delete-icon" title="Excluir Entrega" onclick="deleteDelivery('${d.id}')">
                                <i data-lucide="trash-2" style="width: 18px; height: 18px;"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    const allSorted = [...deliveries].sort((a, b) => new Date(b.date) - new Date(a.date));
    const recent = document.getElementById('recent-deliveries-table')?.querySelector('tbody');
    if (recent) {
        if (allSorted.length === 0) {
            recent.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Nenhuma entrega registrada ainda.</td></tr>`;
        } else {
            recent.innerHTML = allSorted.slice(0, 5).map(d => {
                const prod = producers.find(p => p.id === d.producerId);
                const total = d.liters * (d.price || 0);
                return `
                    <tr>
                        <td>${formatDate(d.date)}</td>
                        <td><strong>${prod ? escapeHtml(prod.name) : 'Excluído'}</strong></td>
                        <td>${d.liters.toFixed(2)} L</td>
                        <td><strong>R$ ${total.toFixed(2)}</strong></td>
                    </tr>
                `;
            }).join('');
        }
    }

    lucide.createIcons();
}

function filterDeliveries() {
    const term = document.getElementById('search-deliveries').value.toLowerCase().trim();
    if (!term) {
        renderDeliveries();
        return;
    }
    const filtered = deliveries.filter(d => {
        const prod = producers.find(p => p.id === d.producerId);
        const prodName = prod ? prod.name.toLowerCase() : '';
        const dateFormatted = formatDate(d.date).toLowerCase();
        return prodName.includes(term) || d.date.includes(term) || dateFormatted.includes(term);
    });
    renderDeliveries(filtered);
}

function openEditDeliveryModal(id) {
    const d = deliveries.find(x => x.id === id);
    if (!d) return;

    const prodSelect = document.getElementById('edit-delivery-producer');
    prodSelect.innerHTML = producers.map(p => `
        <option value="${p.id}" ${p.id === d.producerId ? 'selected' : ''}>${escapeHtml(p.name)}</option>
    `).join('');

    document.getElementById('edit-delivery-id').value = d.id;
    document.getElementById('edit-delivery-date').value = d.date;
    document.getElementById('edit-delivery-liters').value = d.liters;
    document.getElementById('edit-delivery-price').value = d.price;

    openModal('edit-delivery-modal');
}

async function saveEditDelivery(e) {
    e.preventDefault();
    const id = document.getElementById('edit-delivery-id').value;
    const producerId = document.getElementById('edit-delivery-producer').value;
    const date = document.getElementById('edit-delivery-date').value;
    const liters = parseFloat(document.getElementById('edit-delivery-liters').value);
    const price = parseFloat(document.getElementById('edit-delivery-price').value);

    const index = deliveries.findIndex(d => d.id === id);
    if (index !== -1) {
        const { data, error } = await supabaseClient
            .from('deliveries')
            .update({
                producer_id: producerId,
                date,
                liters,
                price
            })
            .eq('id', id)
            .select('id, producer_id, date, liters, price')
            .single();
        if (error) {
            showToast(`Erro ao atualizar entrega: ${error.message}`, 'error');
            return;
        }
        deliveries[index] = mapDelivery(data);
        renderDeliveries();
        renderFortnightSummary();
        updateDashboard();
        closeModal('edit-delivery-modal');
        showToast('Entrega atualizada com sucesso!', 'success');
    }
}

async function deleteDelivery(id) {
    if (confirm('Deseja realmente excluir este registro de entrega?')) {
        const { error } = await supabaseClient.from('deliveries').delete().eq('id', id);
        if (error) {
            showToast(`Erro ao excluir entrega: ${error.message}`, 'error');
            return;
        }
        deliveries = deliveries.filter(d => d.id !== id);
        renderDeliveries();
        renderFortnightSummary();
        updateDashboard();
        showToast('Entrega excluída com sucesso.', 'info');
    }
}

function populateSelects() {
    const deliverySelect = document.getElementById('delivery-producer');
    const reportSelect = document.getElementById('report-producer');

    const options = producers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

    if (deliverySelect) {
        deliverySelect.innerHTML = '<option value="">Selecione um produtor</option>' + options;
    }
    if (reportSelect) {
        reportSelect.innerHTML = '<option value="">Todos os produtores</option>' + options;
    }
}

// ----------------------------------------------------
// Dashboard Metrics & Fortnight Summary
// ----------------------------------------------------

function updateDashboard() {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();

    // Today
    const todayLiters = deliveries
        .filter(d => d.date === today)
        .reduce((sum, d) => sum + d.liters, 0);

    // Month
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const monthLiters = deliveries
        .filter(d => {
            const dDate = new Date(d.date + 'T00:00:00');
            return dDate.getMonth() === currentMonth && dDate.getFullYear() === currentYear;
        })
        .reduce((sum, d) => sum + d.liters, 0);

    // Fortnight
    const isSecondHalf = now.getDate() > 15;
    const fortnightLiters = deliveries
        .filter(d => {
            const dDate = new Date(d.date + 'T00:00:00');
            if (dDate.getMonth() !== currentMonth || dDate.getFullYear() !== currentYear) return false;
            return isSecondHalf ? dDate.getDate() > 15 : dDate.getDate() <= 15;
        })
        .reduce((sum, d) => sum + d.liters, 0);

    document.getElementById('stats-today').innerText = `${todayLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L`;
    document.getElementById('stats-month').innerText = `${monthLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L`;
    document.getElementById('stats-fortnight').innerText = `${fortnightLiters.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L`;
    document.getElementById('stats-producers').innerText = producers.length;
}

function renderFortnightSummary() {
    const list = document.getElementById('fortnight-summary-list');
    if (!list) return;
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const isSecondHalf = now.getDate() > 15;
    const fortnightLabel = isSecondHalf ? '2ª Quinzena' : '1ª Quinzena';

    const summaryData = producers.map(p => {
        const pDeliveries = deliveries.filter(d => {
            const dDate = new Date(d.date + 'T00:00:00');
            const isInMonth = dDate.getMonth() === currentMonth && dDate.getFullYear() === currentYear;
            if (!isInMonth) return false;
            return isSecondHalf ? dDate.getDate() > 15 : dDate.getDate() <= 15;
        }).filter(d => d.producerId === p.id);

        const totalLiters = pDeliveries.reduce((sum, d) => sum + d.liters, 0);
        const totalValue = pDeliveries.reduce((sum, d) => sum + (d.liters * (d.price || 0)), 0);

        return {
            id: p.id,
            name: p.name,
            phone: p.phone,
            deliveriesCount: pDeliveries.length,
            totalLiters,
            totalValue
        };
    }).filter(s => s.totalLiters > 0);

    if (summaryData.length === 0) {
        list.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Nenhuma entrega registrada nesta quinzena (${fortnightLabel}).</td></tr>`;
        return;
    }

    list.innerHTML = summaryData.map(s => `
        <tr>
            <td><strong>${escapeHtml(s.name)}</strong></td>
            <td>${s.totalLiters.toFixed(2)} L</td>
            <td><strong style="color: var(--primary-dark);">R$ ${s.totalValue.toFixed(2)}</strong></td>
            <td>
                <div class="actions-cell">
                    <button class="btn btn-sm btn-whatsapp" onclick="openFortnightReceiptModal('${s.id}')">
                        <i data-lucide="message-circle" style="width: 16px; height: 16px;"></i> Fechamento
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

// ----------------------------------------------------
// WhatsApp, Formats (Texto / JPG / PDF) & Receipts
// ----------------------------------------------------

function setReceiptFormat(format) {
    currentReceiptFormat = format;

    ['text', 'image', 'pdf'].forEach(fmt => {
        const btn = document.getElementById(`btn-fmt-${fmt}`);
        if (btn) btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`btn-fmt-${format}`);
    if (activeBtn) activeBtn.classList.add('active');

    const textPane = document.getElementById('receipt-text-container');
    const visualPane = document.getElementById('receipt-visual-container');
    const downloadBtn = document.getElementById('btn-receipt-download');
    const sendLabel = document.getElementById('btn-send-label');

    if (format === 'text') {
        textPane.classList.add('active');
        visualPane.classList.remove('active');
        if (downloadBtn) {
            downloadBtn.style.display = 'inline-flex';
            downloadBtn.innerHTML = '<i data-lucide="download"></i> Baixar Mensagem (.txt)';
            lucide.createIcons();
        }
        if (sendLabel) sendLabel.innerText = 'Enviar no WhatsApp';
    } else {
        textPane.classList.remove('active');
        visualPane.classList.add('active');
        if (downloadBtn) {
            downloadBtn.style.display = 'inline-flex';
            downloadBtn.innerHTML = format === 'image'
                ? '<i data-lucide="image"></i> Baixar Imagem (JPG)'
                : '<i data-lucide="file-text"></i> Baixar Documento (PDF A4)';
            lucide.createIcons();
        }
        if (sendLabel) {
            sendLabel.innerText = format === 'image' ? 'Enviar JPG no WhatsApp' : 'Enviar PDF no WhatsApp';
        }
    }
}

function openReceiptModal(deliveryId) {
    const delivery = deliveries.find(d => d.id === deliveryId);
    if (!delivery) return;

    const prod = producers.find(p => p.id === delivery.producerId);
    const prodName = prod ? prod.name : 'Produtor';
    const property = prod && prod.property ? prod.property : 'Não informada';
    const phone = prod && prod.phone ? prod.phone : '';
    const total = delivery.liters * (delivery.price || 0);
    const company = settings.dairyName || settings.companyName || 'LeiTech';
    const dateFormatted = formatDate(delivery.date);
    const timeNow = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    activeReceiptMeta = {
        title: `Comprovante - ${prodName} - ${dateFormatted}`,
        fileName: `Comprovante_Leite_${prodName.replace(/\s+/g, '_')}_${delivery.date}`,
        type: 'delivery',
        data: delivery
    };

    // 1. Text Format
    const text = `*COMPROVANTE DE ENTREGA DE LEITE* 🥛\n` +
        `*${company}*\n` +
        `------------------------------------\n` +
        `👤 *Produtor:* ${prodName}\n` +
        `🏡 *Propriedade:* ${property}\n` +
        `📅 *Data:* ${dateFormatted}\n` +
        `🥛 *Volume:* ${delivery.liters.toFixed(2)} Litros\n` +
        `💰 *Valor/Litro:* R$ ${(delivery.price || 0).toFixed(2)}\n` +
        `💵 *TOTAL:* R$ ${total.toFixed(2)}\n` +
        `------------------------------------\n` +
        `Obrigado pela parceria! 👍`;

    document.getElementById('receipt-phone').value = phone;
    document.getElementById('receipt-message').value = text;

    // 2. Visual Ticket Format
    document.getElementById('ticket-company').innerText = company;
    document.getElementById('ticket-badge').innerText = 'COMPROVANTE DE ENTREGA';
    document.getElementById('ticket-body').innerHTML = `
        <div class="ticket-row"><span class="ticket-label">Produtor:</span><span class="ticket-val">${escapeHtml(prodName)}</span></div>
        <div class="ticket-row"><span class="ticket-label">Propriedade:</span><span class="ticket-val">${escapeHtml(property)}</span></div>
        <div class="ticket-row"><span class="ticket-label">Data da Entrega:</span><span class="ticket-val">${dateFormatted}</span></div>
        <div class="ticket-row"><span class="ticket-label">Volume Coletado:</span><span class="ticket-val">${delivery.liters.toFixed(2)} L</span></div>
        <div class="ticket-row"><span class="ticket-label">Preço por Litro:</span><span class="ticket-val">R$ ${(delivery.price || 0).toFixed(2)}</span></div>
    `;
    document.getElementById('ticket-total-value').innerText = `R$ ${total.toFixed(2)}`;
    document.getElementById('ticket-timestamp').innerText = `Emitido em ${new Date().toLocaleDateString('pt-BR')} às ${timeNow}`;

    setReceiptFormat('text');
    openModal('whatsapp-receipt-modal');
}

function openFortnightReceiptModal(producerId) {
    const prod = producers.find(p => p.id === producerId);
    if (!prod) return;

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const isSecondHalf = now.getDate() > 15;
    const fortnightLabel = isSecondHalf ? '2ª Quinzena' : '1ª Quinzena';
    const monthName = now.toLocaleString('pt-BR', { month: 'long', year: 'numeric' });
    const timeNow = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const pDeliveries = deliveries.filter(d => {
        const dDate = new Date(d.date + 'T00:00:00');
        const isInMonth = dDate.getMonth() === currentMonth && dDate.getFullYear() === currentYear;
        if (!isInMonth) return false;
        return isSecondHalf ? dDate.getDate() > 15 : dDate.getDate() <= 15;
    }).filter(d => d.producerId === prod.id)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalLiters = pDeliveries.reduce((sum, d) => sum + d.liters, 0);
    const totalValue = pDeliveries.reduce((sum, d) => sum + (d.liters * (d.price || 0)), 0);
    const company = settings.dairyName || settings.companyName || 'LeiTech';

    activeReceiptMeta = {
        title: `Fechamento Quinzenal - ${prod.name}`,
        fileName: `Fechamento_${prod.name.replace(/\s+/g, '_')}_${fortnightLabel.replace(/\s+/g, '_')}_${currentMonth + 1}_${currentYear}`,
        type: 'fortnight',
        data: { prod, deliveries: pDeliveries }
    };

    let textDetails = '';
    let tableRows = '';
    pDeliveries.forEach(d => {
        const val = d.liters * (d.price || 0);
        textDetails += `• ${formatDate(d.date)}: ${d.liters.toFixed(1)}L - R$ ${val.toFixed(2)}\n`;
        tableRows += `<tr><td>${formatDate(d.date)}</td><td style="text-align: right;">${d.liters.toFixed(1)} L</td><td style="text-align: right;">R$ ${val.toFixed(2)}</td></tr>`;
    });

    // 1. Text Format
    const text = `*FECHAMENTO QUINZENAL DE LEITE* 🥛\n` +
        `*${company}*\n` +
        `------------------------------------\n` +
        `👤 *Produtor:* ${prod.name}\n` +
        `📅 *Período:* ${fortnightLabel} (${monthName})\n` +
        `📦 *Entregas Realizadas:* ${pDeliveries.length}\n` +
        `------------------------------------\n` +
        `*Detalhamento:*\n${textDetails}` +
        `------------------------------------\n` +
        `🥛 *TOTAL DE LITROS:* ${totalLiters.toFixed(2)} L\n` +
        `💰 *TOTAL A RECEBER:* R$ ${totalValue.toFixed(2)}\n` +
        `------------------------------------\n` +
        `Obrigado pela confiança e parceria! 🤝`;

    document.getElementById('receipt-phone').value = prod.phone || '';
    document.getElementById('receipt-message').value = text;

    // 2. Visual Ticket Format
    document.getElementById('ticket-company').innerText = company;
    document.getElementById('ticket-badge').innerText = 'FECHAMENTO QUINZENAL';
    document.getElementById('ticket-body').innerHTML = `
        <div class="ticket-row"><span class="ticket-label">Produtor:</span><span class="ticket-val">${escapeHtml(prod.name)}</span></div>
        <div class="ticket-row"><span class="ticket-label">Propriedade:</span><span class="ticket-val">${escapeHtml(prod.property || '-')}</span></div>
        <div class="ticket-row"><span class="ticket-label">Período:</span><span class="ticket-val">${fortnightLabel} de ${monthName}</span></div>
        <div class="ticket-row"><span class="ticket-label">Total de Coletas:</span><span class="ticket-val">${pDeliveries.length} entregas</span></div>
        <div class="ticket-row"><span class="ticket-label">Volume Total:</span><span class="ticket-val">${totalLiters.toFixed(2)} Litros</span></div>
        <div style="margin-top: 0.5rem;">
            <span class="ticket-label" style="display: block; margin-bottom: 0.3rem;">Extrato de Entregas:</span>
            <table class="ticket-deliveries-table">
                <thead><tr><th>Data</th><th style="text-align: right;">Litros</th><th style="text-align: right;">Valor</th></tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
    `;
    document.getElementById('ticket-total-value').innerText = `R$ ${totalValue.toFixed(2)}`;
    document.getElementById('ticket-timestamp').innerText = `Emitido em ${new Date().toLocaleDateString('pt-BR')} às ${timeNow}`;

    setReceiptFormat('text');
    openModal('whatsapp-receipt-modal');
}

function formatFileDate(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

function sanitizeFileName(value) {
    return String(value || 'arquivo')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
}

function buildExportFileName(prefix, extension) {
    const cleanPrefix = sanitizeFileName(prefix).replace(/\s+/g, '_');
    const dateStamp = formatFileDate();
    return `${cleanPrefix}_${dateStamp}.${extension}`;
}

function triggerDownloadFromDataUrl(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function saveNativeFile(dataUrl, filename, mimeType, target) {
    const nativeBridge = window.AndroidFileSaver;
    if (nativeBridge && typeof nativeBridge.saveFile === 'function') {
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        const result = nativeBridge.saveFile(base64, filename, mimeType, target);
        if (result === 'success') {
            return true;
        }
        console.warn('Native file save failed:', result);
    }
    triggerDownloadFromDataUrl(dataUrl, filename);
    return false;
}

// Generate & Download File (JPG or PDF A4)
async function downloadReceiptFile() {
    if (currentReceiptFormat === 'text') {
        const text = document.getElementById('receipt-message')?.value || '';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${activeReceiptMeta.fileName || 'comprovante'}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast('Mensagem do comprovante baixada no aparelho!', 'success');
        return;
    }

    if (currentReceiptFormat === 'image') {
        const ticket = document.getElementById('receipt-ticket');
        const canvas = await html2canvas(ticket, { scale: 3, backgroundColor: "#ffffff", useCORS: true });
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        const filename = buildExportFileName(`${activeReceiptMeta.fileName || 'comprovante'}_jpg`, 'jpg');
        const savedByNative = saveNativeFile(dataUrl, filename, 'image/jpeg', 'gallery');
        showToast(savedByNative ? 'Imagem salva na galeria do aparelho!' : 'Imagem do comprovante baixada!', 'success');
    } else if (currentReceiptFormat === 'pdf') {
        const ticket = document.getElementById('receipt-ticket');
        const canvas = await html2canvas(ticket, { scale: 3, backgroundColor: "#ffffff", useCORS: true });
        const imgData = canvas.toDataURL('image/jpeg', 0.95);

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const pageWidth = 210;
        const contentWidth = 160;
        const imgProps = pdf.getImageProperties(imgData);
        const contentHeight = (imgProps.height * contentWidth) / imgProps.width;
        const startX = (pageWidth - contentWidth) / 2;
        const startY = 20;

        pdf.addImage(imgData, 'JPEG', startX, startY, contentWidth, contentHeight);
        const pdfDataUrl = pdf.output('datauristring');
        const filename = buildExportFileName(`${activeReceiptMeta.fileName || 'comprovante'}_pdf`, 'pdf');
        const savedByNative = saveNativeFile(pdfDataUrl, filename, 'application/pdf', 'downloads');
        showToast(savedByNative ? 'PDF salvo em Downloads!' : 'Documento PDF A4 do comprovante baixado!', 'success');
    }
}

// Send according to chosen format
async function sendSelectedReceipt() {
    const rawPhone = document.getElementById('receipt-phone').value;
    const message = document.getElementById('receipt-message').value;
    const cleanNumber = sanitizePhone(rawPhone);
    const encodedMessage = encodeURIComponent(message);
    const ticket = document.getElementById('receipt-ticket');

    const openWhatsApp = () => {
        if (cleanNumber) {
            window.open(`https://wa.me/${cleanNumber}?text=${encodedMessage}`, '_blank');
        } else {
            window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
        }
    };

    // 1. TEXT FORMAT
    if (currentReceiptFormat === 'text') {
        openWhatsApp();
        closeModal('whatsapp-receipt-modal');
        showToast('WhatsApp aberto com a mensagem de texto!', 'success');
        return;
    }

    // 2. IMAGE (JPG) FORMAT
    if (currentReceiptFormat === 'image') {
        showToast('Gerando imagem do comprovante...', 'info');
        const canvas = await html2canvas(ticket, { scale: 3, backgroundColor: "#ffffff", useCORS: true });

        canvas.toBlob(async (blob) => {
            const file = new File([blob], `${activeReceiptMeta.fileName}.jpg`, { type: 'image/jpeg' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        title: activeReceiptMeta.title,
                        text: message,
                        files: [file]
                    });
                    closeModal('whatsapp-receipt-modal');
                    showToast('Comprovante compartilhado com sucesso!', 'success');
                    return;
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('Share error:', err);
                    }
                }
            }

            // Fallback: Download JPG and open WhatsApp
            const link = document.createElement('a');
            link.download = `${activeReceiptMeta.fileName}.jpg`;
            link.href = URL.createObjectURL(blob);
            link.click();
            URL.revokeObjectURL(link.href);

            if (cleanNumber) {
                window.open(`https://wa.me/${cleanNumber}?text=${encodedMessage}`, '_blank');
            } else {
                window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
            }
            closeModal('whatsapp-receipt-modal');
            showToast('Imagem baixada e WhatsApp aberto para envio!', 'success');
        }, 'image/jpeg', 0.95);
        return;
    }

    // 3. PDF FORMAT (A4 Portrait)
    if (currentReceiptFormat === 'pdf') {
        showToast('Gerando documento PDF A4...', 'info');
        const canvas = await html2canvas(ticket, { scale: 3, backgroundColor: "#ffffff", useCORS: true });
        const imgData = canvas.toDataURL('image/jpeg', 0.95);

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4' // 210mm x 297mm
        });

        const pageWidth = 210;
        const contentWidth = 160;
        const imgProps = pdf.getImageProperties(imgData);
        const contentHeight = (imgProps.height * contentWidth) / imgProps.width;
        const startX = (pageWidth - contentWidth) / 2;
        const startY = 20;

        pdf.addImage(imgData, 'JPEG', startX, startY, contentWidth, contentHeight);
        const pdfBlob = pdf.output('blob');
        const file = new File([pdfBlob], `${activeReceiptMeta.fileName}.pdf`, { type: 'application/pdf' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({
                    title: activeReceiptMeta.title,
                    text: message,
                    files: [file]
                });
                closeModal('whatsapp-receipt-modal');
                showToast('PDF A4 compartilhado com sucesso!', 'success');
                return;
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Share error:', err);
                }
            }
        }

        pdf.save(`${activeReceiptMeta.fileName}.pdf`);
        if (cleanNumber) {
            window.open(`https://wa.me/${cleanNumber}?text=${encodedMessage}`, '_blank');
        } else {
            window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
        }
        closeModal('whatsapp-receipt-modal');
        showToast('PDF A4 baixado e WhatsApp aberto para envio!', 'success');
    }
}

function openDirectWhatsApp(phone, name) {
    const cleanNumber = sanitizePhone(phone);
    if (!cleanNumber) {
        showToast('Número de telefone inválido.', 'error');
        return;
    }
    const text = encodeURIComponent(`Olá ${name}, tudo bem? Entramos em contato a respeito da coleta de leite do ${settings.companyName || 'LeiTech'}.`);
    window.open(`https://wa.me/${cleanNumber}?text=${text}`, '_blank');
}

function sanitizePhone(phoneStr) {
    if (!phoneStr) return '';
    let digits = phoneStr.replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) {
        digits = '55' + digits;
    }
    return digits;
}

// ----------------------------------------------------
// Reporting Logic
// ----------------------------------------------------

function toggleReportFilters() {
    const type = document.getElementById('report-type').value;
    const producerFilter = document.getElementById('filter-producer');
    const reportDate = document.getElementById('report-date');
    const reportMonth = document.getElementById('report-month');

    if (producerFilter) producerFilter.style.display = type === 'individual' ? 'block' : 'none';
    if (reportDate) reportDate.style.display = type === 'daily' ? 'block' : 'none';
    if (reportMonth) {
        const shouldShowMonth = ['monthly', 'fortnightly', 'individual', 'all-producers'].includes(type);
        reportMonth.style.display = shouldShowMonth ? 'block' : 'none';
    }
}

function generateReport() {
    const type = document.getElementById('report-type').value;
    const month = document.getElementById('report-month').value;
    const date = document.getElementById('report-date').value;
    const producerId = document.getElementById('report-producer').value;

    let filtered = [];
    let title = "";

    if (type === 'daily') {
        filtered = deliveries.filter(d => d.date === date);
        title = `Relatório Diário - ${formatDate(date)}`;
    } else if (type === 'monthly') {
        filtered = deliveries.filter(d => d.date.startsWith(month));
        title = `Relatório Mensal - ${month}`;
    } else if (type === 'fortnightly') {
        filtered = deliveries.filter(d => d.date.startsWith(month));
        title = `Relatório Quinzenal - ${month}`;
    } else if (type === 'all-producers') {
        filtered = month ? deliveries.filter(d => d.date.startsWith(month)) : [...deliveries];
        title = `Relatório Geral de Todos os Produtores${month ? ` - ${month}` : ''}`;
    } else if (type === 'individual') {
        filtered = deliveries.filter(d => d.date.startsWith(month));
        if (producerId) filtered = filtered.filter(d => d.producerId === producerId);
        const p = producers.find(x => x.id === producerId);
        title = `Relatório Individual - ${p ? p.name : 'Todos'} (${month})`;
    }

    renderReportTable(filtered, type);
    document.getElementById('report-title').innerText = title;
    document.getElementById('report-subtitle').innerText = `Gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}`;
    updateReportDairy();
}

function updateReportDairy() {
    const reportDairy = document.getElementById('report-dairy');
    if (!reportDairy) return;

    const dairyName = settings.dairyName?.trim() || '';
    reportDairy.textContent = dairyName ? `Laticínio: ${dairyName}` : '';
    reportDairy.hidden = !dairyName;
}

function buildReportMessage() {
    const title = document.getElementById('report-title')?.innerText || 'Relatório LeiTech';
    const subtitle = document.getElementById('report-subtitle')?.innerText || '';
    const dairy = document.getElementById('report-dairy')?.innerText || '';
    const summary = document.getElementById('report-summary')?.innerText || 'Sem resumo disponível';
    const lines = [
        `*${title}*`,
        subtitle,
        dairy,
        '---',
        summary.replace(/\s+/g, ' ').trim()
    ].filter(Boolean);
    return lines.join('\n');
}

function shareReportByWhatsApp() {
    const message = buildReportMessage();
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
    showToast('WhatsApp aberto com o resumo do relatório.', 'success');
}

async function withReportExportHidden(callback) {
    const element = document.getElementById('report-output');
    if (!element) throw new Error('Relatório não encontrado para exportação.');

    const actionButtons = Array.from(element.querySelectorAll('.no-print'));
    const previousStates = actionButtons.map(btn => ({
        btn,
        display: btn.style.display
    }));

    actionButtons.forEach(btn => {
        btn.style.display = 'none';
    });

    try {
        return await callback();
    } finally {
        previousStates.forEach(({ btn, display }) => {
            btn.style.display = display;
        });
    }
}

async function captureReportCanvas(scale) {
    if (typeof html2canvas !== 'function') {
        throw new Error('A biblioteca de exportação não carregou. Verifique a conexão e tente novamente.');
    }

    const element = document.getElementById('report-output');
    if (!element) throw new Error('Relatório não encontrado para exportação.');

    return withReportExportHidden(() => html2canvas(element, {
        scale,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true
    }));
}

async function downloadReportPdf() {
    const title = document.getElementById('report-title').innerText || 'Relatorio';
    showToast('Gerando PDF do relatório para download...', 'info');

    try {
        const canvas = await captureReportCanvas(2);
        if (!window.jspdf?.jsPDF) {
            throw new Error('A biblioteca de PDF não carregou. Verifique a conexão e tente novamente.');
        }

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageWidth = 210;
        const pageHeight = 297;
        const margin = 10;
        const imgWidth = pageWidth - (margin * 2);
        const printableHeight = pageHeight - margin * 2;
        const pixelsPerMm = canvas.width / imgWidth;
        const sliceHeight = Math.max(1, Math.floor(printableHeight * pixelsPerMm));

        for (let sourceY = 0, page = 0; sourceY < canvas.height; sourceY += sliceHeight, page++) {
            if (page > 0) pdf.addPage();

            const currentCanvas = document.createElement('canvas');
            currentCanvas.width = canvas.width;
            currentCanvas.height = Math.min(sliceHeight, canvas.height - sourceY);
            const ctx = currentCanvas.getContext('2d');
            if (!ctx) throw new Error('Não foi possível preparar uma página do PDF.');

            ctx.drawImage(
                canvas,
                0, sourceY, canvas.width, currentCanvas.height,
                0, 0, canvas.width, currentCanvas.height
            );
            const img = currentCanvas.toDataURL('image/jpeg', 0.95);
            const imageHeight = currentCanvas.height / pixelsPerMm;
            pdf.addImage(img, 'JPEG', margin, margin, imgWidth, imageHeight);
        }

        const filename = buildExportFileName(`Relatorio_${title}`, 'pdf');
        const pdfDataUrl = pdf.output('datauristring');
        const savedByNative = saveNativeFile(pdfDataUrl, filename, 'application/pdf', 'downloads');
        showToast(savedByNative ? 'PDF salvo em Downloads!' : 'PDF do relatório baixado no aparelho!', 'success');
    } catch (err) {
        showToast('Erro ao baixar PDF: ' + (err.message || 'erro desconhecido'), 'error');
    }
}

function renderReportTable(data, type) {
    const head = document.getElementById('report-table-head');
    const body = document.getElementById('report-table-body');
    const summary = document.getElementById('report-summary');

    if (data.length === 0) {
        head.innerHTML = '<th>Resultado</th>';
        body.innerHTML = '<tr><td style="text-align: center; color: var(--text-muted); padding: 2rem;">Nenhuma entrega encontrada para o período selecionado.</td></tr>';
        summary.innerHTML = '<div><strong>Total Litros:</strong> 0,00 L</div><div><strong>Total Dinheiro:</strong> R$ 0,00</div>';
        return;
    }

    if (type === 'all-producers') {
        const consolidated = producers.map(p => {
            const list = data.filter(d => d.producerId === p.id);
            const totalLiters = list.reduce((sum, d) => sum + d.liters, 0);
            const totalValue = list.reduce((sum, d) => sum + (d.liters * (d.price || 0)), 0);
            return {
                name: p.name,
                property: p.property || '-',
                deliveries: list.length,
                totalLiters,
                totalValue
            };
        }).filter(item => item.deliveries > 0 || item.totalLiters > 0);

        head.innerHTML = '<th>Produtor</th><th>Propriedade</th><th>Entregas</th><th>Total de Litros</th><th>Valor Total (R$)</th>';
        body.innerHTML = consolidated.map(item => `
            <tr>
                <td><strong>${escapeHtml(item.name)}</strong></td>
                <td>${escapeHtml(item.property)}</td>
                <td>${item.deliveries}</td>
                <td>${item.totalLiters.toFixed(2)} L</td>
                <td><strong style="color: var(--primary-dark);">R$ ${item.totalValue.toFixed(2)}</strong></td>
            </tr>
        `).join('');

        const totalL = consolidated.reduce((sum, item) => sum + item.totalLiters, 0);
        const totalV = consolidated.reduce((sum, item) => sum + item.totalValue, 0);
        summary.innerHTML = `
            <div><strong>Total Geral de Litros:</strong> ${totalL.toFixed(2)} L</div>
            <div><strong>Total Geral em Dinheiro:</strong> R$ ${totalV.toFixed(2)}</div>
            <div style="grid-column: 1 / -1; margin-top: 10px; font-size: 1.1rem; color: var(--primary-dark); font-weight: 700;">
                Produtores no relatório: ${consolidated.length}
            </div>
        `;
        return;
    }

    if (type === 'daily') {
        head.innerHTML = '<th>Produtor</th><th>Propriedade</th><th>Litros</th><th>Preço/L</th><th>Valor Total (R$)</th>';
        body.innerHTML = data.map(d => {
            const p = producers.find(x => x.id === d.producerId);
            const totalVal = d.liters * (d.price || 0);
            return `<tr><td><strong>${p ? escapeHtml(p.name) : 'Excluído'}</strong></td><td>${p ? escapeHtml(p.property) : '-'}</td><td>${d.liters.toFixed(2)} L</td><td>R$ ${(d.price || 0).toFixed(2)}</td><td><strong>R$ ${totalVal.toFixed(2)}</strong></td></tr>`;
        }).join('');

        const totalL = data.reduce((s, d) => s + d.liters, 0);
        const totalV = data.reduce((s, d) => s + (d.liters * (d.price || 0)), 0);
        summary.innerHTML = `
            <div><strong>Total Litros Coletados:</strong> ${totalL.toFixed(2)} L</div>
            <div><strong>Total em Dinheiro:</strong> R$ ${totalV.toFixed(2)}</div>
        `;
    }
    else if (type === 'fortnightly') {
        head.innerHTML = '<th>Produtor</th><th>Q1 (Litros)</th><th>Q1 (R$)</th><th>Q2 (Litros)</th><th>Q2 (R$)</th><th>Total (L)</th><th>Total (R$)</th>';
        const prodData = producers.map(p => {
            const pDeliveries = data.filter(d => d.producerId === p.id);
            const d1 = pDeliveries.filter(d => new Date(d.date + 'T00:00:00').getDate() <= 15);
            const d2 = pDeliveries.filter(d => new Date(d.date + 'T00:00:00').getDate() > 15);

            const q1L = d1.reduce((s, d) => s + d.liters, 0);
            const q1V = d1.reduce((s, d) => s + d.liters * (d.price || 0), 0);
            const q2L = d2.reduce((s, d) => s + d.liters, 0);
            const q2V = d2.reduce((s, d) => s + d.liters * (d.price || 0), 0);

            return { name: p.name, q1L, q1V, q2L, q2V, totalL: q1L + q2L, totalV: q1V + q2V };
        }).filter(x => x.totalL > 0);

        body.innerHTML = prodData.map(d => `
            <tr>
                <td><strong>${escapeHtml(d.name)}</strong></td>
                <td>${d.q1L.toFixed(2)} L</td>
                <td>R$ ${d.q1V.toFixed(2)}</td>
                <td>${d.q2L.toFixed(2)} L</td>
                <td>R$ ${d.q2V.toFixed(2)}</td>
                <td><strong>${d.totalL.toFixed(2)} L</strong></td>
                <td><strong style="color: var(--primary-dark);">R$ ${d.totalV.toFixed(2)}</strong></td>
            </tr>
        `).join('');

        const t1L = prodData.reduce((s, d) => s + d.q1L, 0);
        const t1V = prodData.reduce((s, d) => s + d.q1V, 0);
        const t2L = prodData.reduce((s, d) => s + d.q2L, 0);
        const t2V = prodData.reduce((s, d) => s + d.q2V, 0);

        summary.innerHTML = `
            <div><strong>Total 1ª Quinzena:</strong> ${t1L.toFixed(2)} L (R$ ${t1V.toFixed(2)})</div>
            <div><strong>Total 2ª Quinzena:</strong> ${t2L.toFixed(2)} L (R$ ${t2V.toFixed(2)})</div>
            <div style="grid-column: 1 / -1; margin-top: 10px; font-size: 1.2rem; color: var(--primary-dark); font-weight: 700;">
                Total Geral: ${(t1L + t2L).toFixed(2)} L | R$ ${(t1V + t2V).toFixed(2)}
            </div>
        `;
    }
    else {
        head.innerHTML = '<th>Data</th><th>Produtor</th><th>Litros</th><th>Preço/L</th><th>Valor Total (R$)</th>';
        body.innerHTML = data.sort((a, b) => new Date(a.date) - new Date(b.date)).map(d => {
            const p = producers.find(x => x.id === d.producerId);
            const totalVal = d.liters * (d.price || 0);
            return `<tr><td>${formatDate(d.date)}</td><td><strong>${p ? escapeHtml(p.name) : 'Excluído'}</strong></td><td>${d.liters.toFixed(2)} L</td><td>R$ ${(d.price || 0).toFixed(2)}</td><td><strong>R$ ${totalVal.toFixed(2)}</strong></td></tr>`;
        }).join('');

        const totalL = data.reduce((s, d) => s + d.liters, 0);
        const totalV = data.reduce((s, d) => s + (d.liters * (d.price || 0)), 0);
        summary.innerHTML = `
            <div><strong>Total Litros:</strong> ${totalL.toFixed(2)} L</div>
            <div><strong>Total Dinheiro:</strong> R$ ${totalV.toFixed(2)}</div>
        `;
    }
}

// ----------------------------------------------------
// Backup & Settings
// ----------------------------------------------------

function exportBackupJSON() {
    const backupData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        producers,
        deliveries,
        settings
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `leitech_backup_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('Backup exportado com sucesso!', 'success');
}

function importBackupJSON(event) {
    if (!isAdmin) {
        showToast('Apenas administradores podem restaurar backups.', 'error');
        event.target.value = '';
        return;
    }
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data.producers) || !Array.isArray(data.deliveries)) {
                showToast('Arquivo de backup inválido!', 'error');
                return;
            }

            if (confirm(`Restaurar backup com ${data.producers.length} produtores e ${data.deliveries.length} entregas? Isso substituirá os dados atuais.`)) {
                const restoredSettings = normalizeSettings(data.settings || settings);
                const { error } = await supabaseClient.rpc('restore_shared_backup', {
                    producers_json: data.producers,
                    deliveries_json: data.deliveries,
                    settings_json: restoredSettings
                });
                if (error) {
                    showToast(`Erro ao restaurar backup: ${error.message}`, 'error');
                    return;
                }

                producers = data.producers.map(mapProducer);
                deliveries = data.deliveries.map(delivery => ({
                    id: delivery.id,
                    producerId: delivery.producerId || delivery.producer_id || '',
                    date: delivery.date,
                    liters: Number(delivery.liters),
                    price: Number(delivery.price || 0)
                }));
                settings = restoredSettings;

                loadPreferences();
                updateReportDairy();
                renderProducers();
                renderDeliveries();
                renderFortnightSummary();
                updateDashboard();
                populateSelects();

                showToast('Backup restaurado com sucesso!', 'success');
            }
        } catch (err) {
            showToast('Erro ao processar arquivo JSON: ' + err.message, 'error');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function loadPreferences() {
    const defaultPriceInput = document.getElementById('pref-default-price');
    const deliveryPriceInput = document.getElementById('delivery-price');
    const dairyNameInput = document.getElementById('dairy-name');

    if (defaultPriceInput && settings.defaultPrice) {
        defaultPriceInput.value = settings.defaultPrice;
    }
    if (dairyNameInput) dairyNameInput.value = settings.dairyName || '';
    if (deliveryPriceInput && settings.defaultPrice && !deliveryPriceInput.value) {
        deliveryPriceInput.value = settings.defaultPrice;
    }
}

async function savePreferences(e) {
    e.preventDefault();
    if (!isAdmin) {
        showToast('Apenas administradores podem alterar as preferências.', 'error');
        return;
    }
    const defaultPrice = document.getElementById('pref-default-price').value;
    const updatedSettings = { ...settings, defaultPrice };
    try {
        await persistSharedSettings(updatedSettings);
    } catch (error) {
        showToast(`Erro ao salvar preferências: ${error.message}`, 'error');
        return;
    }
    settings = updatedSettings;

    const deliveryPriceInput = document.getElementById('delivery-price');
    if (deliveryPriceInput && defaultPrice) {
        deliveryPriceInput.value = defaultPrice;
    }

    showToast('Preferências salvas com sucesso!', 'success');
}

async function clearAllData() {
    if (!isAdmin) {
        showToast('Apenas administradores podem apagar os dados.', 'error');
        return;
    }
    const confirm1 = confirm('ATENÇÃO: Você tem certeza que deseja APAGAR TODOS os dados de produtores e entregas?');
    if (!confirm1) return;

    const confirm2 = prompt('Para confirmar a exclusão total, digite LIMPAR abaixo:');
    if (confirm2 === 'LIMPAR') {
        const { error } = await supabaseClient.rpc('clear_shared_data');
        if (error) {
            showToast(`Erro ao apagar dados: ${error.message}`, 'error');
            return;
        }
        producers = [];
        deliveries = [];
        renderProducers();
        renderDeliveries();
        renderFortnightSummary();
        updateDashboard();
        populateSelects();
        showToast('Todos os dados foram apagados.', 'info');
    } else {
        showToast('Ação cancelada.', 'info');
    }
}

// ----------------------------------------------------
// UI Helpers, Modals & Toasts
// ----------------------------------------------------

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('active');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('active');
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconName = 'check-circle';
    if (type === 'error') iconName = 'alert-circle';
    if (type === 'info') iconName = 'info';

    toast.innerHTML = `
        <i data-lucide="${iconName}" style="width: 20px; height: 20px;"></i>
        <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function formatDate(dateStr) {
    if (!dateStr) return "-";
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
}

function escapeHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function exportToJPG() {
    const title = document.getElementById('report-title').innerText || 'Relatorio';

    showToast('Gerando imagem em formato A4 Retrato (21x28)...', 'info');

    try {
        const capturedCanvas = await captureReportCanvas(2.5);
        // Formato A4 Retrato (Proporção 210 x 297 mm / 21x28 em 150-200 DPI)
        const a4Width = 1240;
        const a4Ratio = 297 / 210; // ~1.414
        const minA4Height = Math.round(a4Width * a4Ratio); // 1754 px

        // Margens proporcionais
        const marginX = 60;
        const marginY = 80;
        const printableWidth = a4Width - (marginX * 2);
        const scaleFactor = printableWidth / capturedCanvas.width;
        const contentHeight = capturedCanvas.height * scaleFactor;

        // Altura final da imagem
        const finalCanvasHeight = Math.max(minA4Height, contentHeight + (marginY * 2) + 70);

        const a4Canvas = document.createElement('canvas');
        a4Canvas.width = a4Width;
        a4Canvas.height = finalCanvasHeight;
        const ctx = a4Canvas.getContext('2d');

        // Fundo Branco A4
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, a4Width, finalCanvasHeight);

        // Borda decorativa superior Marrom Dourado
        ctx.fillStyle = "#8c5a2b";
        ctx.fillRect(0, 0, a4Width, 10);

        // Desenhar conteúdo do relatório centralizado
        ctx.drawImage(capturedCanvas, marginX, marginY, printableWidth, contentHeight);

        // Rodapé elegante
        ctx.fillStyle = "#7d7265";
        ctx.font = "14px 'Inter', sans-serif";
        ctx.textAlign = "center";
        const footerY = finalCanvasHeight - 30;
        const nowStr = new Date().toLocaleDateString('pt-BR') + ' às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        ctx.fillText(`LeiTech - Gestão de Leite • Formato A4 Retrato (21x28) • Emitido em ${nowStr}`, a4Width / 2, footerY);

        const filename = buildExportFileName(`Relatorio_${title}_A4`, 'jpg');
        const dataUrl = a4Canvas.toDataURL('image/jpeg', 0.95);
        const savedByNative = saveNativeFile(dataUrl, filename, 'image/jpeg', 'gallery');
        showToast(savedByNative ? 'Imagem salva na galeria do aparelho!' : 'Relatório em formato A4 Retrato (21x28) exportado!', 'success');
    } catch (err) {
        showToast('Erro ao exportar imagem A4: ' + (err.message || 'erro desconhecido'), 'error');
    }
}
