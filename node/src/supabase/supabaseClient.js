const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;           // REST URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;  // service_role key

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;