// netlify/functions/update-dates.js
// ──────────────────────────────────────────────────────────────────────
// Called by the dashboard when a key date is edited inline.
// Upserts the date value for a specific label on a specific deal.
//
// ENV VARS REQUIRED:
//   SUPABASE_URL         → Supabase project URL
//   SUPABASE_SERVICE_KEY → Supabase service role key (NOT anon key)
// ──────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(200, {}, true);
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  const { deal_id, label, date_value, row_id } = payload;

  if (!deal_id) return respond(400, { error: 'deal_id is required' });
  if (!label)   return respond(400, { error: 'label is required' });

  // Look up the transaction ID from the deal slug
  const { data: tx, error: txErr } = await sb
    .from('transactions')
    .select('id')
    .eq('deal_id', deal_id)
    .single();

  if (txErr || !tx) {
    return respond(404, { error: `No transaction found for deal_id "${deal_id}"` });
  }

  const status = date_value ? 'set' : 'pending';

  let result;

  if (row_id) {
    // Update existing row by ID
    const { data, error } = await sb
      .from('key_dates')
      .update({ date_value: date_value || null, status })
      .eq('id', row_id)
      .select('id')
      .single();

    if (error) {
      console.error('update-dates update error:', error);
      return respond(500, { error: 'Failed to update date: ' + error.message });
    }
    result = data;
  } else {
    // Upsert by transaction_id + label (row may not exist yet for this label)
    const { data, error } = await sb
      .from('key_dates')
      .upsert(
        { transaction_id: tx.id, label, date_value: date_value || null, status },
        { onConflict: 'transaction_id,label', ignoreDuplicates: false }
      )
      .select('id')
      .single();

    if (error) {
      console.error('update-dates upsert error:', error);
      return respond(500, { error: 'Failed to upsert date: ' + error.message });
    }
    result = data;
  }

  console.log(`✅ Date updated: deal=${deal_id} label="${label}" value="${date_value || 'cleared'}"`);

  return respond(200, {
    ok:         true,
    deal_id,
    label,
    date_value: date_value || null,
    row_id:     result?.id || row_id,
  });
};

function respond(status, body, preflight = false) {
  return {
    statusCode: status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: preflight ? '' : JSON.stringify(body),
  };
}
