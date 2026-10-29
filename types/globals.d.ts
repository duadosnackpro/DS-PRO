// Deklarasi global klien (config.js dan jembatan antar berkas). Menambah tipe di sini = pemeriksaan tipe makin ketat tanpa mengubah kode.
interface Window { CONFIG: { VERSION: string; SUPABASE_URL?: string; SUPABASE_KEY?: string }; APP: any; SBAPI: any; }
