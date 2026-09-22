import { supabase } from './supabase.js';
import { showToast } from './utils.js';
import { fetchExcelDownload } from './excel_download_core.js';
async function downloadExcel(button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Формую XLSX…';
    try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (!token) throw new Error('Потрібна активна сесія STRUM.');
        const { blob, filename } = await fetchExcelDownload(token);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('Excel export готовий');
    } catch (error) { showToast(`Не вдалося створити XLSX: ${error.message}`); }
    finally { button.disabled = false; button.textContent = original; }
}
export function initExcelExport(){document.querySelectorAll('[data-action="export-xlsx"]').forEach((button)=>{if(button.dataset.bound)return;button.dataset.bound='true';button.addEventListener('click',()=>downloadExcel(button));});}
