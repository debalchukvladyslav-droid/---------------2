// === js/admin.js ===
import { supabase } from './supabase.js';

const ROLES = ['trader', 'mentor', 'admin'];

export async function renderAdminPanel() {
    const container = document.getElementById('admin-users-list');
    if (!container) return;

    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem;">⏳ Завантаження...</p>';

    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, nick, email, first_name, last_name, team, role')
        .order('nick', { ascending: true });

    if (error) {
        container.innerHTML = `<p style="color:var(--loss);">❌ Помилка: ${error.message}</p>`;
        return;
    }

    if (!profiles?.length) {
        container.innerHTML = '<p style="color:var(--text-muted);">Користувачів не знайдено.</p>';
        return;
    }

    container.innerHTML = '';
    profiles.forEach(p => container.appendChild(buildUserRow(p)));
}

function buildUserRow(profile) {
    const row = document.createElement('div');
    row.id = `admin-row-${profile.id}`;
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:8px;background:var(--bg-main);border:1px solid var(--border);flex-wrap:wrap;';

    // Інфо
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:160px;';
    info.innerHTML = `
        <div style="font-weight:600;color:var(--text-main);font-size:0.95rem;">${profile.nick || '—'}</div>
        <div style="color:var(--text-muted);font-size:0.78rem;">${profile.first_name || ''} ${profile.last_name || ''} · ${profile.email || ''}</div>
        <div style="color:var(--text-muted);font-size:0.78rem;">Кущ: ${profile.team || '—'}</div>
    `;

    // Перемикач ролі
    const roleSelect = document.createElement('select');
    roleSelect.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-panel);color:var(--text-main);font-size:0.85rem;cursor:pointer;';
    ROLES.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r.charAt(0).toUpperCase() + r.slice(1);
        opt.selected = (profile.role || 'trader') === r;
        roleSelect.appendChild(opt);
    });
    roleSelect.addEventListener('change', () => updateUserRole(profile.id, roleSelect.value, roleSelect));

    // Кнопка видалення
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑 Видалити';
    delBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:none;background:var(--loss);color:#fff;cursor:pointer;font-size:0.85rem;white-space:nowrap;';
    delBtn.addEventListener('click', () => deleteUser(profile.id, profile.nick, row));

    row.appendChild(info);
    row.appendChild(roleSelect);
    row.appendChild(delBtn);
    return row;
}

async function updateUserRole(userId, newRole, selectEl) {
    const prev = selectEl.value;
    selectEl.disabled = true;

    const { error } = await supabase
        .from('profiles')
        .update({ role: newRole })
        .eq('id', userId);

    selectEl.disabled = false;

    if (error) {
        alert('❌ Помилка зміни ролі: ' + error.message);
        selectEl.value = prev;
    } else {
        showAdminToast(`✅ Роль змінено на «${newRole}»`);
    }
}

async function deleteUser(userId, nick, rowEl) {
    if (!confirm(`Видалити акаунт «${nick}»? Це незворотна дія.`)) return;

    rowEl.style.opacity = '0.4';
    rowEl.style.pointerEvents = 'none';

    const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('id', userId);

    if (error) {
        rowEl.style.opacity = '';
        rowEl.style.pointerEvents = '';
        alert('❌ Помилка видалення: ' + error.message);
    } else {
        rowEl.remove();
        showAdminToast(`🗑 Акаунт «${nick}» видалено`);
    }
}

function showAdminToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-panel);border:1px solid var(--border);color:var(--text-main);padding:10px 22px;border-radius:10px;font-size:0.9rem;z-index:99999;pointer-events:none;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}
