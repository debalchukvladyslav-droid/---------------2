import { state } from './state.js';
import {
    deleteBackground,
    loadBackgroundGallery,
    setActiveBackground,
    uploadBackground,
} from './storage.js';

async function applyBackgroundUrl(url) {
    let resolvedUrl = url;
    try {
        const { getSupabaseStorageUrl } = await import('./supabase_storage.js');
        resolvedUrl = await getSupabaseStorageUrl(url);
    } catch (error) {
        console.warn('[BgPersist] Could not resolve storage URL:', error);
    }

    document.body.style.backgroundImage = `url('${resolvedUrl}')`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
}

function clearBackgroundStyle() {
    document.body.style.backgroundImage = '';
    document.body.style.backgroundSize = '';
    document.body.style.backgroundPosition = '';
    document.body.style.backgroundAttachment = '';
}

export function applyPersistedBackground() {
    const url = state.appData?.activeBackground;
    if (!url) return;
    console.info('[BgPersist] Restoring background:', url);
    void applyBackgroundUrl(url);
}

async function handleBackgroundImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';

    const reader = new FileReader();
    reader.onload = (readerEvent) => {
        applyBackgroundUrl(readerEvent.target.result);
    };
    reader.readAsDataURL(file);

    try {
        const downloadURL = await uploadBackground(file, state.USER_DOC_NAME);
        console.info('[BgUpload] Persisted:', downloadURL);
        await applyBackgroundUrl(downloadURL);
        loadBackgroundGallery();
    } catch (error) {
        console.error('[BgUpload] Storage upload failed:', error);
    }
}

async function setActiveBackgroundFromGallery(url) {
    try {
        await setActiveBackground(url, state.USER_DOC_NAME);
        await applyBackgroundUrl(url);
        loadBackgroundGallery();
    } catch (error) {
        console.error('[BgGallery] setActive failed:', error);
    }
}

async function deleteBackgroundFromGallery(url) {
    try {
        const wasActive = state.appData.activeBackground === url;
        await deleteBackground(url, state.USER_DOC_NAME);
        if (wasActive) clearBackgroundStyle();
        loadBackgroundGallery();
    } catch (error) {
        console.error('[BgGallery] delete failed:', error);
    }
}

export function initBackgroundControls() {
    window._handleBgImageUpload = handleBackgroundImageUpload;
    window._setActiveBackground = setActiveBackgroundFromGallery;
    window._deleteBackground = deleteBackgroundFromGallery;
}
