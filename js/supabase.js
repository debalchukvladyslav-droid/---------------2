// === js/supabase.js ===
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://gijarvlerztfggxhuvow.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4gU0201mMkinUqwH-4SkWA_eSoNqew6';

// Ініціалізуємо єдину точку доступу до бази, авторизації та сховища
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);