// ═══════════════════════════════════════════════════════════════════
// scripts/fub-poller.js
//
// Runs via GitHub Actions every 5 minutes.
// Polls FUB API for newly completed "Portal:" tasks,
// then updates Supabase milestones accordingly.
// ═══════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ─── VALIDATE ENV VARS ───────────────────────────────────────────
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, FUB_API_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !FUB_API_KEY) {
  console.error('❌ Missing required environment variables:');
  if (!SUPABASE_URL)         console.error('   - SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) console.error('   - SUPABASE_SERVICE_KEY');
  if (!FUB_API_KEY)          console.error('   - FUB_API_KEY');
  process.exit(1);
}

// ─── SUPABASE CLIENT ─────────────────────────────────────────────
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── FUB API CONFIG ──────────────────────────────────────────────
const FUB_API_BASE = 'https://api.followupboss.com/v1';

function fubAuthHeader() {
  const token = Buffer.from(`${FUB_API_KEY}:`).toString('base64');
  return {
    'Authorization': `Basic ${token}`,
    'Content-Type': 'application/json',
  };
}

// ─── TASK → MILESTONE INDEX MAP ──────────────────────────────────
const TASK_MAP = {
  'Portal: Buyer consultation':            0,
  'Portal: Agency Agreement signed':       1,
  'Portal: Pre-approval received':         2,
  'Portal: Offer submitted':               3,
  'Portal: Offer accepted':                4,
  'Portal: Earnest money delivered':       5,
  'Portal: Inspection scheduled':          6,
  'Portal: Inspection completed':          7,
  'Portal: Inspection response submitted': 8,
  'Portal: Inspection response agreed':    9,
  'Portal: Appraisal ordered':            10,
  'Portal: Appraisal completed':          11,
  'Portal: Clear to close':               12,
  'Portal: Closing date confirmed':       13,
  'Portal: Final walkthrough':            14,
  'Portal: Keys in hand':                 15,
  'Portal: Home insurance confirmed':     16,
  'Portal: Utilities transferred':        17,
};

// ─── GET LAST POLLED TIMESTAMP ───────────────────────────────────
async function getLastPolledAt() {
  const { data, error } = await sb
    .from('poll_state')
    .select('last_polled_at')
    .eq('id', 1)
    .single();

  if (error || !data) {
    console.warn('[poller] poll_state row missing — using 10min fallback');
    return new Date(Date.now() - 10 * 60 * 1000).toISOString();
  }

  return data.last_polled_at;
}

// ─── SAVE LAST POLLED TIMESTAMP ──────────────────────────────────
async function setLastPolledAt(isoString) {
  const { error } = await sb
    .from('poll_state')
    .update({ last_polled_at: isoString })
    .eq('id', 1);

  if (error) {
    console.error('[poller] Failed to update poll_state:', error);
  }
}

// ─── FETCH RECENTLY COMPLETED PORTAL TASKS FROM FUB ─────────────
async function fetchRecentFubTasks(sinceISO) {
  const url = `${FUB_API_BASE}/tasks?sort=updated&direction=desc&limit=200`;

  const res = await fetch(url, { headers: fubAuthHeader() });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FUB API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  // FUB returns tasks in different shapes depending on version
  const allTasks = data.tasks || data._embedded?.tasks || [];

  console.log(`[poller] FUB returned ${allTasks.length} total tasks`);
if (allTasks.length > 0) {
  console.log('[poller] Sample task structure:', JSON.stringify(allTasks[0], null, 2));
}

  const since = new Date(sinceISO);

 const filtered = allTasks.filter(task => {
    const updatedAt = new Date(task.updated || task.updatedAt || 0);
    const inWindow = updatedAt > since;
    const isComplete = (task.isCompleted === true || task.isCompleted === 1);
    const isPortal = TASK_MAP[task.name] !== undefined;
    
    if (inWindow && isComplete) {
      console.log(`[poller] Completed task in window: name="${task.name}" isPortal=${isPortal} updated=${task.updated}`);
    }
    
    return inWindow && isComplete && isPortal;
  });

  return filtered;
}

// ─── PROCESS A SINGLE COMPLETED TASK ────────────────────────────
async function processTask(task) {
  const milestoneIdx = TASK_MAP[task.name];
  const fubPersonId  = task.personId;

  if (!fubPersonId) {
    console.warn(`[poller] Task "${task.name}" has no personId — skipping`);
    return { skipped: true, reason: 'no_person_id' };
  }

  // Find the Supabase transaction for this FUB contact
  const { data: tx, error: txErr } = await sb
    .from('transactions')
    .select('id, deal_id')
    .eq('fub_person_id', fubPersonId)
    .single();

  if (txErr || !tx) {
    console.log(`[poller] No portal transaction for FUB person ${fubPersonId} — skipping`);
    return { skipped: true, reason: 'no_transaction' };
  }

  // Mark milestone complete — only if not already marked (idempotent)
  const { error: updateErr } = await sb
    .from('milestones')
    .update({
      completed:    true,
      completed_at: new Date().toISOString(),
    })
    .eq('transaction_id', tx.id)
    .eq('milestone_idx', milestoneIdx)
    .eq('completed', false);

  if (updateErr) {
    console.error(`[poller] DB update failed for deal=${tx.deal_id} idx=${milestoneIdx}:`, updateErr);
    return { skipped: true, reason: 'db_error' };
  }

  console.log(`[poller] ✅ Updated: deal=${tx.deal_id} | idx=${milestoneIdx} | task="${task.name}"`);
  return { ok: true, deal: tx.deal_id, idx: milestoneIdx };
}

// ─── MAIN ────────────────────────────────────────────────────────
async function main() {
  console.log('[poller] 🔄 Poll cycle started:', new Date().toISOString());

  try {
    const lastPolledAt = await getLastPolledAt();
    console.log(`[poller] Looking for tasks updated since: ${lastPolledAt}`);

    // Stamp poll start time BEFORE the API call to avoid gaps
    const pollStarted = new Date().toISOString();

    const tasks = await fetchRecentFubTasks(lastPolledAt);
    console.log(`[poller] Found ${tasks.length} newly completed portal task(s)`);

    const results = await Promise.all(tasks.map(processTask));
    const updated = results.filter(r => r.ok).length;
    const skipped = results.filter(r => r.skipped).length;

    await setLastPolledAt(pollStarted);

    console.log(`[poller] ✅ Cycle complete — updated: ${updated}, skipped: ${skipped}`);
    process.exit(0);

  } catch (err) {
    console.error('[poller] ❌ Poll cycle failed:', err);
    process.exit(1);
  }
}

main();
