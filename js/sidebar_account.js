// === Профіль у лівому сайдбарі (над «Згорнути») ===
import { supabase } from './supabase.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { loadTeams } from './teams.js';
import { getSupabaseStorageUrl, uploadToSupabaseStorage } from './supabase_storage.js';

const DEFAULT_TEAM_LABEL = 'Без куща';

let _listenersBound = false;
let _avatarCrop = null;

function myNick() {
    return state.USER_DOC_NAME ? state.USER_DOC_NAME.replace('_stats', '') : '';
}

function initialsFromProfile(p) {
    return (
        (p?.first_name?.[0] || '') + (p?.last_name?.[0] || '') ||
        (p?.nick || '').slice(0, 2)
    ).toUpperCase() || '?';
}

function paintSidebarAvatar(el, p) {
    if (!el) return;
    el.innerHTML = '';
    el.classList.remove('sidebar-account-avatar-emoji', 'has-image');
    const st = p?.settings && typeof p.settings === 'object' ? p.settings : {};
    const url = (st.avatar_url || '').trim();
    const emoji = (st.avatar_emoji || '').trim().slice(0, 8);
    if (url) {
        const img = document.createElement('img');
        img.className = 'sidebar-account-avatar-img';
        const needsResolve = !/^https?:\/\//i.test(url) || url.includes('/storage/v1/object/');
        img.src = needsResolve ? '' : url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            el.innerHTML = '';
            el.textContent = initialsFromProfile(p);
        });
        el.appendChild(img);
        el.classList.add('has-image');
        if (needsResolve) {
            getSupabaseStorageUrl(url)
                .then((resolved) => {
                    if (resolved) img.src = resolved;
                    else {
                        el.innerHTML = '';
                        el.textContent = initialsFromProfile(p);
                    }
                })
                .catch(() => {
                    el.innerHTML = '';
                    el.textContent = initialsFromProfile(p);
                });
        }
        return;
    }
    if (emoji) {
        el.textContent = emoji;
        el.classList.add('sidebar-account-avatar-emoji');
        return;
    }
    el.textContent = initialsFromProfile(p);
}

function bindAvatarPicker() {
    const grid = document.getElementById('sidebar-pf-emoji-grid');
    const hidden = document.getElementById('sidebar-pf-emoji');
    const clearBtn = document.getElementById('sidebar-pf-avatar-clear');
    const fileInp = document.getElementById('sidebar-pf-avatar-file');
    const pickBtn = document.getElementById('sidebar-pf-avatar-pick');
    if (!grid || !hidden) return;
    grid.querySelectorAll('button[data-emoji]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-emoji') || '';
            hidden.value = v;
            grid.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.remove('picked'));
            btn.classList.add('picked');
            const urlInp = document.getElementById('sidebar-pf-avatar-url');
            if (urlInp) urlInp.value = '';
            resetAvatarCropper();
        });
    });
    clearBtn?.addEventListener('click', () => {
        hidden.value = '';
        grid.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.remove('picked'));
        const urlInp = document.getElementById('sidebar-pf-avatar-url');
        if (urlInp) urlInp.value = '';
        resetAvatarCropper();
    });
    const urlInp = document.getElementById('sidebar-pf-avatar-url');
    urlInp?.addEventListener('input', () => {
        if (urlInp.value.trim()) {
            hidden.value = '';
            grid.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.remove('picked'));
        }
    });
    pickBtn?.addEventListener('click', () => fileInp?.click());
    fileInp?.addEventListener('change', () => {
        const file = fileInp.files?.[0];
        if (file) startAvatarCrop(file);
        fileInp.value = '';
    });
    bindAvatarCropperControls();
}

function clearEmojiPick() {
    const hidden = document.getElementById('sidebar-pf-emoji');
    if (hidden) hidden.value = '';
    document.querySelectorAll('#sidebar-pf-emoji-grid button[data-emoji]').forEach((b) => b.classList.remove('picked'));
}

function resetAvatarCropper() {
    if (_avatarCrop?.objectUrl) URL.revokeObjectURL(_avatarCrop.objectUrl);
    _avatarCrop = null;
    const cropper = document.getElementById('sidebar-avatar-cropper');
    const img = document.getElementById('sidebar-avatar-crop-img');
    const zoom = document.getElementById('sidebar-avatar-zoom');
    if (cropper) cropper.hidden = true;
    if (img) {
        img.removeAttribute('src');
        img.style.transform = '';
    }
    if (zoom) zoom.value = '1';
}

function startAvatarCrop(file) {
    if (!file.type?.startsWith('image/')) {
        showToast('Please choose an image file');
        return;
    }
    if (file.size > 8 * 1024 * 1024) {
        showToast('Image is too large. Choose a file up to 8 MB');
        return;
    }
    resetAvatarCropper();
    clearEmojiPick();
    const urlInp = document.getElementById('sidebar-pf-avatar-url');
    if (urlInp) urlInp.value = '';
    const objectUrl = URL.createObjectURL(file);
    const img = document.getElementById('sidebar-avatar-crop-img');
    const cropper = document.getElementById('sidebar-avatar-cropper');
    if (!img || !cropper) return;
    _avatarCrop = { file, objectUrl, x: 0, y: 0, zoom: 1, dragging: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
    img.onload = () => renderAvatarCropTransform();
    img.src = objectUrl;
    cropper.hidden = false;
}

function bindAvatarCropperControls() {
    const stage = document.getElementById('sidebar-avatar-crop-stage');
    const zoom = document.getElementById('sidebar-avatar-zoom');
    if (!stage || !zoom) return;
    zoom.addEventListener('input', () => {
        if (!_avatarCrop) return;
        _avatarCrop.zoom = Number(zoom.value) || 1;
        renderAvatarCropTransform();
    });
    stage.addEventListener('pointerdown', (e) => {
        if (!_avatarCrop) return;
        _avatarCrop.dragging = true;
        _avatarCrop.startX = e.clientX;
        _avatarCrop.startY = e.clientY;
        _avatarCrop.baseX = _avatarCrop.x;
        _avatarCrop.baseY = _avatarCrop.y;
        stage.setPointerCapture?.(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
        if (!_avatarCrop?.dragging) return;
        _avatarCrop.x = _avatarCrop.baseX + e.clientX - _avatarCrop.startX;
        _avatarCrop.y = _avatarCrop.baseY + e.clientY - _avatarCrop.startY;
        renderAvatarCropTransform();
    });
    stage.addEventListener('pointerup', (e) => {
        if (!_avatarCrop) return;
        _avatarCrop.dragging = false;
        stage.releasePointerCapture?.(e.pointerId);
    });
    stage.addEventListener('pointercancel', () => {
        if (_avatarCrop) _avatarCrop.dragging = false;
    });
}

function renderAvatarCropTransform() {
    const img = document.getElementById('sidebar-avatar-crop-img');
    if (!img || !_avatarCrop) return;
    img.style.transform = `translate(-50%, -50%) translate(${_avatarCrop.x}px, ${_avatarCrop.y}px) scale(${_avatarCrop.zoom})`;
}

function getAvatarCropBlob() {
    return new Promise((resolve, reject) => {
        const crop = _avatarCrop;
        const img = document.getElementById('sidebar-avatar-crop-img');
        const stage = document.getElementById('sidebar-avatar-crop-stage');
        if (!crop || !img || !stage || !img.naturalWidth || !img.naturalHeight) {
            resolve(null);
            return;
        }
        const out = 512;
        const canvas = document.createElement('canvas');
        canvas.width = out;
        canvas.height = out;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            reject(new Error('Canvas is not available'));
            return;
        }
        const stageSize = Math.max(1, stage.getBoundingClientRect().width || 260);
        const ringInset = stageSize * 0.09;
        const ringSize = stageSize - ringInset * 2;
        const baseScale = Math.max(stageSize / img.naturalWidth, stageSize / img.naturalHeight);
        const displayScale = baseScale * crop.zoom;
        const drawnW = img.naturalWidth * displayScale;
        const drawnH = img.naturalHeight * displayScale;
        const scaleToCanvas = out / ringSize;
        const dx = ((stageSize - drawnW) / 2 + crop.x - ringInset) * scaleToCanvas;
        const dy = ((stageSize - drawnH) / 2 + crop.y - ringInset) * scaleToCanvas;
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, out, out);
        ctx.drawImage(img, dx, dy, drawnW * scaleToCanvas, drawnH * scaleToCanvas);
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Could not prepare avatar image'));
        }, 'image/webp', 0.9);
    });
}

async function uploadCroppedAvatar() {
    const blob = await getAvatarCropBlob();
    if (!blob) return '';
    const userId = state.myUserId || (await supabase.auth.getUser())?.data?.user?.id || '';
    if (!userId) throw new Error('Missing user id');
    const file = new File([blob], 'avatar.webp', { type: 'image/webp' });
    const path = `avatars/${userId}/avatar.webp`;
    await uploadToSupabaseStorage(path, file, { contentType: 'image/webp' });
    return path;
}

function bindOnce() {
    if (_listenersBound) return;
    _listenersBound = true;
    const trigger = document.getElementById('sidebar-account-trigger');
    const dropdown = document.getElementById('sidebar-account-dropdown');
    const saveBtn = document.getElementById('sidebar-pf-save');
    bindAvatarPicker();
    if (trigger && dropdown) {
        const acc = document.getElementById('sidebar-account');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = dropdown.hidden;
            dropdown.hidden = !willOpen;
            trigger.setAttribute('aria-expanded', String(willOpen));
        });
        document.addEventListener('click', (e) => {
            if (!acc || acc.contains(e.target)) return;
            if (!dropdown.hidden) {
                dropdown.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !dropdown || dropdown.hidden) return;
            dropdown.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        });
    }
    saveBtn?.addEventListener('click', () => saveSidebarProfile());
}

export function initSidebarAccount() {
    bindOnce();
}

export async function refreshSidebarAccount() {
    bindOnce();
    const nick = myNick();
    const avatar = document.getElementById('sidebar-account-avatar');
    const nameEl = document.getElementById('sidebar-account-name');
    const teamEl = document.getElementById('sidebar-account-team');
    const subEl = document.getElementById('sidebar-account-sub');
    const nickRO = document.getElementById('sidebar-pf-nick');
    const teamRO = document.getElementById('sidebar-pf-team-display');

    if (!nick) {
        if (nameEl) nameEl.textContent = '—';
        if (teamEl) teamEl.textContent = '';
        if (subEl) subEl.textContent = '';
        if (avatar) {
            avatar.innerHTML = '';
            avatar.textContent = '?';
        }
        if (nickRO) nickRO.textContent = '—';
        if (teamRO) teamRO.textContent = '—';
        return;
    }

    const { data: p, error } = await supabase
        .from('profiles')
        .select('first_name, last_name, team, nick, email, mentor_enabled, role, settings')
        .eq('nick', nick)
        .maybeSingle();

    if (error || !p) return;

    paintSidebarAvatar(avatar, p);

    const disp = p.first_name && p.last_name ? `${p.first_name} ${p.last_name}` : p.nick;
    if (nameEl) nameEl.textContent = disp;
    const teamLabel = p.team || DEFAULT_TEAM_LABEL;
    if (teamEl) teamEl.textContent = teamLabel;
    if (nickRO) nickRO.textContent = p.nick || nick;
    if (teamRO) teamRO.textContent = teamLabel;

    const st = p.settings && typeof p.settings === 'object' ? p.settings : {};
    const subParts = [];
    if (p.email) subParts.push(p.email);
    const authProv = (st.auth_provider || state.authProvider || '').toLowerCase();
    if (authProv === 'telegram') subParts.push('Telegram');
    if (p.mentor_enabled || p.role === 'mentor') subParts.push('Ментор');
    if (p.role === 'admin') subParts.push('Адмін');
    if (subEl) subEl.textContent = subParts.join(' · ');

    const fn = document.getElementById('sidebar-pf-fname');
    const ln = document.getElementById('sidebar-pf-lname');
    const urlInp = document.getElementById('sidebar-pf-avatar-url');
    const hiddenEmoji = document.getElementById('sidebar-pf-emoji');
    if (fn) fn.value = p.first_name || '';
    if (ln) ln.value = p.last_name || '';
    if (document.getElementById('view-dash')?.classList.contains('active')) {
        window.refreshCurrentMainTitle?.();
    }
    if (urlInp) urlInp.value = st.avatar_url || '';
    resetAvatarCropper();
    const em = st.avatar_emoji || '';
    if (hiddenEmoji) hiddenEmoji.value = em;
    document.querySelectorAll('#sidebar-pf-emoji-grid button[data-emoji]').forEach((b) => {
        b.classList.toggle('picked', b.getAttribute('data-emoji') === em);
    });
}

async function saveSidebarProfile() {
    const nick = myNick();
    if (!nick) return;

    const fname = document.getElementById('sidebar-pf-fname')?.value.trim() || '';
    const lname = document.getElementById('sidebar-pf-lname')?.value.trim() || '';
    const urlRaw = document.getElementById('sidebar-pf-avatar-url')?.value.trim() || '';
    const emojiPick = document.getElementById('sidebar-pf-emoji')?.value.trim().slice(0, 8) || '';

    if (!fname || !lname) {
        showToast("Вкажіть ім'я та прізвище");
        return;
    }

    const { data: existing, error: fetchErr } = await supabase.from('profiles').select('settings').eq('nick', nick).maybeSingle();
    if (fetchErr) {
        showToast('Помилка: ' + fetchErr.message);
        return;
    }

    const prevSettings = existing?.settings && typeof existing.settings === 'object' ? existing.settings : {};
    const settings = { ...prevSettings };
    let avatarPath = urlRaw;
    try {
        const uploadedAvatar = await uploadCroppedAvatar();
        if (uploadedAvatar) avatarPath = uploadedAvatar;
    } catch (uploadErr) {
        showToast('Could not upload avatar: ' + (uploadErr?.message || uploadErr));
        return;
    }
    if (avatarPath) {
        settings.avatar_url = avatarPath;
        delete settings.avatar_emoji;
    } else {
        delete settings.avatar_url;
        if (emojiPick) settings.avatar_emoji = emojiPick;
        else delete settings.avatar_emoji;
    }

    const { error } = await supabase
        .from('profiles')
        .update({
            first_name: fname,
            last_name: lname,
            settings,
        })
        .eq('nick', nick);

    if (error) {
        showToast('Не вдалося зберегти: ' + error.message);
        return;
    }

    const displayName = `${lname} ${fname} (${nick})`;
    for (const group of Object.keys(state.TEAM_GROUPS)) {
        const arr = state.TEAM_GROUPS[group];
        const idx = arr.findIndex((t) => {
            const clean = t.includes('(') && t.includes(')') ? t.split('(')[1].replace(')', '').trim() : t.trim();
            return clean === nick;
        });
        if (idx > -1) arr[idx] = displayName;
    }

    await loadTeams();
    await refreshSidebarAccount();
    if (window.renderTeamSidebar) window.renderTeamSidebar();
    if (window.renderStatsSourceSelector) window.renderStatsSourceSelector();
    showToast('Профіль оновлено');
}
