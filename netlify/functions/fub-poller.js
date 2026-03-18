// ═══════════════════════════════════════════════════════════════════
// netlify/functions/fub-poller.js
//
// Runs every 5 minutes via Netlify Scheduled Functions.
// Polls FUB API for newly completed "Portal:" tasks,
// then updates Supabase milestones accordingly.
//
// No FUB webhook plan required. Fully self-contained.
// ═══════════════════════════════════════════════════════════════════

const { schedule }    = require('@netlify/functions');
const { createClient } = require('@supabase/supabase-js');

// ─── SUPABASE CLIENT (service key for read/write) ────────────────
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── FUB API CONFIG ──────────────────────────────────────────────
const FUB_API_BASE = 'https://api.followupboss.com/v1';

// FUB uses HTTP Basic Auth: API key as username, empty password
function fubAuthHeader() {
  const token = Buffer.from(`${process.env.FUB_API_KEY}:`).toString('base64');
  return { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json' };
}

// ─── TASK → MILESTONE INDEX MAP ─────────────────────────────────
// Must match your FUB Action Plan task names exactly (case-sensitive)
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

// ─── FETCH RECENTLY UPDATED TASKS FROM FUB ──────────────────────
// Pulls the 200 most recently updated tasks, sorted newest first.
// We filter client-side to only process tasks updated since last poll.
async function fetchRecentFubTasks(sinceISO) {
  const url = `${FUB_API_BASE}/tasks?sort=updated&direction=desc&limit=200`;

  const res = await fetch(url, { headers: fubAuthHeader() });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FUB API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const allTasks = data.tasks || data._embedded?.tasks || [];

  // Filter to tasks that:
  // 1. Were updated after our last poll window
  // 2. Are completed
  // 3. Have a name that maps to a portal milestone
  const since = new Date(sinceISO);

  return allTasks.filter(task => {
    const updatedAt = new Date(task.updatedAt || task.updated || 0);
    return (
      updatedAt > since &&
      task.isCompleted === true &&
      TASK_MAP[task.name] !== undefined
    );
  });
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
    // Not every FUB contact has a portal — that's normal
    console.log(`[poller] No portal transaction for FUB person ${fubPersonId} — skipping`);
    return { skipped: true, reason: 'no_transaction' };
  }

  // Mark milestone complete (upsert-style: won't error if already done)
  const { error: updateErr } = await sb
    .from('milestones')
    .update({
      completed:    true,
      completed_at: new Date().toISOString(),
    })
    .eq('transaction_id', tx.id)
    .eq('milestone_idx', milestoneIdx)
    .eq('completed', false); // Only update if not already marked — idempotent

  if (updateErr) {
    console.error(`[poller] Supabase update failed for deal=${tx.deal_id} idx=${milestoneIdx}:`, updateErr);
    return { skipped: true, reason: 'db_error' };
  }

  console.log(`[poller] ✅ Updated: deal=${tx.deal_id} | idx=${milestoneIdx} | task="${task.name}"`);
  return { ok: true, deal: tx.deal_id, idx: milestoneIdx };
}

// ─── GET LAST POLL TIMESTAMP FROM SUPABASE ──────────────────────
async function getLastPolledAt() {
  const { data, error } = await sb
    .from('poll_state')
    .select('last_polled_at')
    .eq('id', 1)
    .single();

  if (error || !data) {
    // Fallback: look back 10 minutes if state row is missing
    console.warn('[poller] poll_state row missing — using 10min fallback');
    return new Date(Date.now() - 10 * 60 * 1000).toISOString();
  }

  return data.last_polled_at;
}

// ─── UPDATE LAST POLL TIMESTAMP IN SUPABASE ─────────────────────
async function setLastPolledAt(isoString) {
  const { error } = await sb
    .from('poll_state')
    .update({ last_polled_at: isoString })
    .eq('id', 1);

  if (error) {
    console.error('[poller] Failed to update poll_state:', error);
  }
}

// ─── MAIN HANDLER — runs on schedule ────────────────────────────
const handler = async () => {
  console.log('[poller] 🔄 Poll cycle started:', new Date().toISOString());

  try {
    // 1. Get the last time we polled
    const lastPolledAt = await getLastPolledAt();
    console.log(`[poller] Looking for tasks updated since: ${lastPolledAt}`);

    // 2. Stamp the new poll time BEFORE the API call
    //    This prevents a gap if the function takes time to run
    const pollStarted = new Date().toISOString();

    // 3. Fetch newly completed portal tasks from FUB
    const tasks = await fetchRecentFubTasks(lastPolledAt);
    console.log(`[poller] Found ${tasks.length} newly completed portal task(s)`);

    // 4. Process each task
    const results = await Promise.all(tasks.map(processTask));
    const updated = results.filter(r => r.ok).length;
    const skipped = results.filter(r => r.skipped).length;

    // 5. Save the new poll timestamp
    await setLastPolledAt(pollStarted);

    console.log(`[poller] ✅ Cycle complete — updated: ${updated}, skipped: ${skipped}`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('[poller] ❌ Poll cycle failed:', err);
    // Don't update last_polled_at on failure — next run will retry the same window
    return { statusCode: 500 };
  }
};

// ─── EXPORT WITH SCHEDULE ────────────────────────────────────────
// Runs every 5 minutes. Netlify free tier supports this.
// Cron syntax: minute hour day month weekday
exports.handler = schedule('*/5 * * * *', handler);
