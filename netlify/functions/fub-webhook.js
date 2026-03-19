// netlify/functions/fub-webhook.js
// ──────────────────────────────────────────────────────────────────────
// Receives FUB taskUpdated webhooks.
// When you complete a "Portal:" task in FUB, this function marks the
// corresponding milestone as complete in Supabase.
// The portal reflects the change on next load — zero client clicks needed.
//
// ENV VARS REQUIRED:
//   SUPABASE_URL          → Supabase project URL
//   SUPABASE_SERVICE_KEY  → Supabase service role key (NOT anon key)
//
// FUB WEBHOOK SETUP:
//   Admin → Settings → Integrations → Webhooks → Add Webhook
//   Event: taskUpdated
//   URL:   https://your-site.netlify.app/.netlify/functions/fub-webhook
// ──────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Exact FUB task name → milestone index mapping.
// Must match your FUB task names character-for-character.
const TASK_MAP = {
  'Portal: Buyer consultation':           0,
  'Portal: Agency Agreement signed':      1,
  'Portal: Pre-approval received':        2,
  'Portal: Offer submitted':              3,
  'Portal: Offer accepted':               4,
  'Portal: Earnest money delivered':      5,
  'Portal: Inspection scheduled':         6,
  'Portal: Inspection completed':         7,
  'Portal: Inspection response submitted':8,
  'Portal: Inspection response agreed':   9,
  'Portal: Appraisal ordered':           10,
  'Portal: Appraisal completed':         11,
  'Portal: Clear to close':              12,
  'Portal: Closing date confirmed':      13,
  'Portal: Final walkthrough':           14,
  'Portal: Keys in hand':                15,
  'Portal: Home insurance confirmed':    16,
  'Portal: Utilities transferred':       17,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const payload = JSON.parse(event.body);

    // Only handle task events
    if (payload.event !== 'taskUpdated') {
      return { statusCode: 200, body: 'Not a task event — ignored' };
    }

    const task = payload.task;

    // Only process completions, not edits or reopens
    if (!task?.isCompleted) {
      return { statusCode: 200, body: 'Task not completed — ignored' };
    }

    // Only process Portal: tasks — everything else is ignored
    const milestoneIdx = TASK_MAP[task.name];
    if (milestoneIdx === undefined) {
      return { statusCode: 200, body: 'Not a portal task — ignored' };
    }

    const fubPersonId = task.personId;
    if (!fubPersonId) {
      console.warn('No personId on task payload', task);
      return { statusCode: 200, body: 'No personId found' };
    }

    // Look up transaction by FUB person ID
    const { data: tx, error: txErr } = await sb
      .from('transactions')
      .select('id, deal_id')
      .eq('fub_person_id', fubPersonId)
      .single();

    if (txErr || !tx) {
      console.log('No portal transaction for FUB person:', fubPersonId);
      return { statusCode: 200, body: 'No matching transaction — ignored' };
    }

    // Mark the milestone complete
    const { error: updateErr } = await sb
      .from('milestones')
      .update({
        completed:    true,
        completed_at: new Date().toISOString(),
      })
      .eq('transaction_id', tx.id)
      .eq('milestone_idx', milestoneIdx);

    if (updateErr) {
      console.error('Supabase update error:', updateErr);
      return { statusCode: 500, body: 'DB update failed' };
    }

    console.log(`✅ Portal updated: deal=${tx.deal_id} idx=${milestoneIdx} task="${task.name}"`);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, deal: tx.deal_id, idx: milestoneIdx }),
    };

  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};
