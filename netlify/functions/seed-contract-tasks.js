// netlify/functions/seed-contract-tasks.js
// ──────────────────────────────────────────────────────────────────────
// Triggered by a FUB Automation 2.0 webhook when a deal stage changes
// to "Under Contract".
//
// Does two things:
//   1. Looks up the portal transaction in Supabase by FUB person ID
//   2. Creates contract tasks (idx 3–17) on the FUB contact via FUB API
//
// This function is intentionally idempotent — if it fires twice for the
// same deal (e.g. stage reset and re-triggered), it checks FUB for
// existing Portal: tasks before creating duplicates.
//
// ENV VARS REQUIRED:
//   SUPABASE_URL          → Supabase project URL
//   SUPABASE_SERVICE_KEY  → Supabase service role key
//   FUB_API_KEY           → FUB API key (Admin → Settings → API)
//
// FUB AUTOMATION 2.0 SETUP:
//   Trigger:  Deal Stage Changed → Pipeline: Buyers → Stage: Under Contract
//   Action:   Send Webhook → POST → https://your-site.netlify.app/.netlify/functions/seed-contract-tasks
//   Payload:  FUB sends the deal/person context automatically
// ──────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CONTRACT TASKS: idx 3–17 ──────────────────────────────────────────
// Pre-offer tasks (idx 0–2) were already created by create-deal.js.
const CONTRACT_MILESTONES = [
  { idx: 3,  task_name: 'Portal: Offer submitted' },
  { idx: 4,  task_name: 'Portal: Offer accepted' },
  { idx: 5,  task_name: 'Portal: Earnest money delivered' },
  { idx: 6,  task_name: 'Portal: Inspection scheduled' },
  { idx: 7,  task_name: 'Portal: Inspection completed' },
  { idx: 8,  task_name: 'Portal: Inspection response submitted' },
  { idx: 9,  task_name: 'Portal: Inspection response agreed' },
  { idx: 10, task_name: 'Portal: Appraisal ordered' },
  { idx: 11, task_name: 'Portal: Appraisal completed' },
  { idx: 12, task_name: 'Portal: Clear to close' },
  { idx: 13, task_name: 'Portal: Closing date confirmed' },
  { idx: 14, task_name: 'Portal: Final walkthrough' },
  { idx: 15, task_name: 'Portal: Keys in hand' },
  { idx: 16, task_name: 'Portal: Home insurance confirmed' },
  { idx: 17, task_name: 'Portal: Utilities transferred' },
];

// ─────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {

  if (event.httpMethod === 'OPTIONS') return respond(200, {}, true);
  if (event.httpMethod !== 'POST')    return respond(405, { error: 'Method not allowed' });

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Invalid JSON body' });
  }

  // ── EXTRACT FUB PERSON ID ──────────────────────────────────────────
  // FUB Automations 2.0 webhook payload for a deal stage change looks like:
  // {
  //   event: "dealUpdated",
  //   deal: { id, stageId, stageName, personId, ... },
  //   person: { id, name, ... }
  // }
  // We support both the deal.personId path and a direct personId for flexibility.
  const fubPersonId =
    payload?.deal?.personId ||
    payload?.person?.id     ||
    payload?.personId       ||
    null;

  const stageName =
    payload?.deal?.stageName ||
    payload?.stageName       ||
    '';

  if (!fubPersonId) {
    console.warn('seed-contract-tasks: no personId found in payload', JSON.stringify(payload));
    return respond(200, { skipped: true, reason: 'No personId in webhook payload' });
  }

  // Safety check — only proceed if stage is actually Under Contract.
  // Protects against misconfigured automations sending other stage changes here.
  if (stageName && stageName !== 'Under Contract') {
    console.log(`seed-contract-tasks: stage is "${stageName}" — not Under Contract, skipping`);
    return respond(200, { skipped: true, reason: `Stage "${stageName}" is not Under Contract` });
  }

  console.log(`seed-contract-tasks: firing for FUB person_id=${fubPersonId}`);

  // ── LOOK UP PORTAL TRANSACTION ────────────────────────────────────
  const { data: tx, error: txErr } = await sb
    .from('transactions')
    .select('id, deal_id, fub_person_id')
    .eq('fub_person_id', fubPersonId)
    .single();

  if (txErr || !tx) {
    // Not every FUB contact will have a portal — this is expected. Log and exit cleanly.
    console.log(`seed-contract-tasks: no portal transaction for person_id=${fubPersonId} — skipping`);
    return respond(200, { skipped: true, reason: 'No portal transaction found for this contact' });
  }

  // ── FUB API SETUP ─────────────────────────────────────────────────
  const fubApiKey = process.env.FUB_API_KEY;
  if (!fubApiKey) {
    console.error('seed-contract-tasks: FUB_API_KEY not set');
    return respond(500, { error: 'FUB_API_KEY environment variable is missing' });
  }

  const fubAuthHeader = 'Basic ' + Buffer.from(`${fubApiKey}:`).toString('base64');

  // ── IDEMPOTENCY CHECK ─────────────────────────────────────────────
  // Check if contract tasks already exist on this contact to prevent duplicates.
  // We check for the existence of "Portal: Offer submitted" (idx 3) as a proxy.
  const alreadySeeded = await checkTaskExists({
    personId:   fubPersonId,
    taskName:   'Portal: Offer submitted',
    authHeader: fubAuthHeader,
  });

  if (alreadySeeded) {
    console.log(`seed-contract-tasks: contract tasks already exist for person_id=${fubPersonId} — skipping duplicate creation`);
    return respond(200, {
      skipped: true,
      reason:  'Contract tasks already exist on this contact',
      deal_id: tx.deal_id,
    });
  }

  // ── CREATE CONTRACT TASKS IN FUB (idx 3–17) ───────────────────────
  const today = new Date().toISOString().split('T')[0];

  const fubResults = await Promise.allSettled(
    CONTRACT_MILESTONES.map(m => createFubTask({
      personId:   fubPersonId,
      name:       m.task_name,
      dueDate:    today,
      authHeader: fubAuthHeader,
    }))
  );

  const succeeded = fubResults.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
  const failed    = fubResults.filter(r => r.status === 'rejected'  || !r.value?.ok);

  if (failed.length > 0) {
    console.warn(`seed-contract-tasks: ${succeeded} succeeded, ${failed.length} failed`);
    failed.forEach(f => console.warn('  Failed:', f.reason || f.value?.error));
  } else {
    console.log(`✅ seed-contract-tasks: ${succeeded}/15 contract tasks created for deal=${tx.deal_id}`);
  }

  return respond(200, {
    ok:                    true,
    deal_id:               tx.deal_id,
    fub_person_id:         fubPersonId,
    contract_tasks_created: succeeded,
    contract_tasks_failed:  failed.length,
    warning: failed.length > 0
      ? `${failed.length} contract task(s) failed to create. Check Netlify logs.`
      : null,
  });
};

// ─────────────────────────────────────────────────────────────────────
// CHECK IF A SPECIFIC TASK ALREADY EXISTS ON A CONTACT
// Used for idempotency — prevents duplicate task creation if the
// automation fires more than once for the same deal.
// ─────────────────────────────────────────────────────────────────────
async function checkTaskExists({ personId, taskName, authHeader }) {
  try {
    const res = await fetch(
      `https://api.followupboss.com/v1/tasks?personId=${personId}&limit=50`,
      {
        headers: {
          'Authorization': authHeader,
          'X-System':      'KO Portal',
          'X-System-Key':  'ko-portal-v2',
        },
      }
    );

    if (!res.ok) return false; // If check fails, proceed with creation (safe default)

    const data = await res.json().catch(() => ({ tasks: [] }));
    const tasks = data.tasks || data._embedded?.tasks || [];
    return tasks.some(t => t.name === taskName && !t.isCompleted);
  } catch {
    return false; // Network error on check — proceed with creation
  }
}

// ─────────────────────────────────────────────────────────────────────
// CREATE A SINGLE FUB TASK
// ─────────────────────────────────────────────────────────────────────
async function createFubTask({ personId, name, dueDate, authHeader }) {
  const res = await fetch('https://api.followupboss.com/v1/tasks', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': authHeader,
      'X-System':      'KO Portal',
      'X-System-Key':  'ko-portal-v2',
    },
    body: JSON.stringify({
      personId:    personId,
      name:        name,
      dueDate:     dueDate,
      type:        'Task',
      isCompleted: false,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.errorMessage || `HTTP ${res.status}`, task: name };
  return { ok: true, fub_task_id: data.id, task: name };
}

// ─────────────────────────────────────────────────────────────────────
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
