// routes/packet-builder.js
//
// Generates a 4-page client session packet as a PDF buffer.
// Pure function — takes hydrated data, returns Uint8Array.
//
// Pages:
//   1. This Session        pre/post bars, operator observations, target band hit rate
//   2. Progress So Far     stress + focus trajectory, target-band gain trend (or baseline note)
//   3. Your Brain Map      plain-English explainer, target band highlighted
//   4. Your Takeaway       practice tied to target band, next session prompt
//
// Design intent: calm & warm (NOT the Halo console cyan-on-void). This lives in the
// client's hand — needs to feel like a gift, not a medical report.

const { PDFDocument, StandardFonts, rgb, PageSizes } = require('pdf-lib');

// ---------------- palette & type ----------------
const INK        = rgb(0.13, 0.13, 0.13);   // body text  — warm charcoal
const INK_SOFT   = rgb(0.42, 0.42, 0.40);   // secondary  — warm grey
const ACCENT     = rgb(0.17, 0.38, 0.47);   // teal-blue  — calm primary
const ACCENT_LT  = rgb(0.82, 0.90, 0.93);   // accent bg  — very soft teal
const CREAM      = rgb(0.97, 0.96, 0.93);   // page-accent wash
const POSITIVE   = rgb(0.24, 0.55, 0.35);   // improvement green
const CAUTION    = rgb(0.76, 0.48, 0.18);   // growth-opportunity amber
const HAIRLINE   = rgb(0.87, 0.85, 0.80);   // divider lines

const MARGIN_X   = 54;
const MARGIN_TOP = 62;
const PAGE_W     = PageSizes.Letter[0];
const PAGE_H     = PageSizes.Letter[1];
const CONTENT_W  = PAGE_W - MARGIN_X * 2;

// ---------------- plain-language translations ----------------
const BAND_NAMES = {
  delta: 'Delta — deep rest',
  theta: 'Theta — creative flow',
  alpha: 'Alpha — calm awareness',
  smr:   'SMR — focused attention',
  beta:  'Beta — active engagement',
  gamma: 'Gamma — peak cognition',
};
const BAND_DESCRIPTIONS = {
  delta: 'The slowest brainwaves — present in deep, restorative sleep and in some deep meditation. When delta is abundant, your body repairs itself.',
  theta: 'Present in dreamlike states, deep relaxation, and moments of creative insight. Often felt as being "in flow" while daydreaming or creating.',
  alpha: 'The bridge between active thought and relaxation. Strong alpha feels like a settled mind — aware but not racing. Many people know this feeling from a long walk or a quiet morning.',
  smr:   'Sensorimotor rhythm. Associated with calm, body-aware focus. Athletes call it "the zone." Well-developed SMR supports both attention and steady sleep.',
  beta:  'Active engaged thinking. Problem-solving, conversation, task completion. Healthy beta is the workhorse of a productive day.',
  gamma: 'The fastest brainwaves. Linked with moments of insight and high-level cognitive integration. Rare to sustain but powerful in brief bursts.',
};
const TAKEAWAYS = {
  delta: {
    title: 'The 10-Minute Wind-Down',
    steps: [
      'One hour before bed, dim every light around you to the lowest setting.',
      'Put your phone in another room. Not face-down — another room.',
      'Sit on the edge of your bed. Place both feet flat on the floor.',
      'Breathe in for 4 seconds. Hold 2 seconds. Out for 8 seconds. Repeat ten times.',
      'If your mind wanders, simply count breaths. No judgment.',
    ],
    why: 'The long exhale signals safety to your nervous system. Delta sleep is when your body heals — giving it the conditions to arrive is a gift to everything else you want to accomplish.',
    scripture: '"In vain you rise early and stay up late, toiling for food to eat — for he grants sleep to those he loves."   — Psalm 127:2',
  },
  theta: {
    title: 'The Ten-Minute Wander',
    steps: [
      'Set a timer for 10 minutes.',
      'Sit or lie down somewhere quiet. Close your eyes.',
      'Picture a place you know well — real or imagined. A room, a trail, a shore.',
      'Wander through it in your mind. Notice details — textures, light, smell, sound.',
      'Do not direct the journey. Let it unfold. If you drift to something else, follow it.',
      'When the timer ends, spend 60 seconds writing or sketching one thing you saw.',
    ],
    why: 'Theta is the state where unexpected connections happen. Practicing this loosens the grip of focused thought and invites insight. Most "aha" moments live here.',
    scripture: '"Whatever is true, whatever is noble, whatever is right, whatever is pure, whatever is lovely — think about such things."   — Philippians 4:8',
  },
  alpha: {
    title: 'Box Breathing — 4-4-4-4',
    steps: [
      'Sit comfortably. Back supported. Feet flat if possible.',
      'Breathe IN through your nose — count 1, 2, 3, 4.',
      'HOLD — count 1, 2, 3, 4.',
      'Breathe OUT through your nose — count 1, 2, 3, 4.',
      'HOLD empty — count 1, 2, 3, 4.',
      'That is one round. Do ten rounds. Takes about three minutes.',
    ],
    why: 'Equal-ratio breathing is the fastest non-medication path to alpha. Used by Navy SEALs, emergency surgeons, and trauma therapists. Works because it steadies your heart rhythm, which steadies your brain.',
    scripture: '"Do not be anxious about anything... and the peace of God, which transcends all understanding, will guard your hearts and your minds."   — Philippians 4:6-7',
  },
  smr: {
    title: 'The 90-Second Anchor',
    steps: [
      'Pick one small object nearby — a coin, a cup, a pen.',
      'Hold it. Notice five details you\'ve never noticed before.',
      'Name them quietly to yourself.',
      'Set it down. Close your eyes for 30 seconds.',
      'Recall those five details from memory.',
      'Do this three times a day for a week.',
    ],
    why: 'SMR is trainable — it\'s one of the most responsive bands in neurofeedback research. Brief, deliberate attention drills compound fast. Ten days of this is often enough to notice sharper focus.',
    scripture: '"Let your eyes look straight ahead; fix your gaze directly before you."   — Proverbs 4:25',
  },
  beta: {
    title: 'The Hard Problem Hour',
    steps: [
      'Pick ONE problem that matters to you — not urgent-busywork.',
      'Set a timer for 50 minutes.',
      'No phone. No browser tabs. No music with words.',
      'Work on that problem only. When you stall, write down what you\'re stuck on.',
      'When the timer ends, stop. Even if you feel you could keep going.',
      'Take a 10-minute walk — outside if possible — before doing anything else.',
    ],
    why: 'Healthy beta needs deep work AND recovery. Most people have the first part backwards — they fragment their focus all day. Training your brain to sustain and release attention is the craft of getting hard things done.',
    scripture: '"Whatever you do, work at it with all your heart, as working for the Lord, not for human masters."   — Colossians 3:23',
  },
  gamma: {
    title: 'The Cross-Domain Connect',
    steps: [
      'Pick two things you care about that seem unrelated — a hobby and your work, or two different interests.',
      'Set a timer for 15 minutes.',
      'Write down five ways one could teach you something about the other.',
      'Do not filter. Weird answers are the point.',
      'Circle one of the five. Try it in real life this week.',
    ],
    why: 'Gamma correlates with moments of integration — when the brain binds unrelated concepts together. You can practice creating those moments. Over time, insight stops feeling random.',
    scripture: '"If any of you lacks wisdom, you should ask God, who gives generously to all without finding fault."   — James 1:5',
  },
};

// ---------------- tiny helpers ----------------
function drawText(page, text, x, y, opts = {}) {
  const {
    size = 10.5, font, color = INK, maxWidth = null, lineHeight = 1.4,
  } = opts;
  if (!maxWidth) {
    page.drawText(String(text), { x, y, size, font, color });
    return y - size * lineHeight;
  }
  // Word wrap
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  let cy = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: cy, size, font, color });
    cy -= size * lineHeight;
  }
  return cy;
}

function hairline(page, y, x1 = MARGIN_X, x2 = PAGE_W - MARGIN_X) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color: HAIRLINE });
}

function drawHeader(page, fonts, subtitle) {
  page.drawText('DreamSonic', {
    x: MARGIN_X, y: PAGE_H - 44, size: 18, font: fonts.bold, color: ACCENT,
  });
  page.drawText(subtitle.toUpperCase(), {
    x: MARGIN_X, y: PAGE_H - 58, size: 8.5, font: fonts.mono, color: INK_SOFT,
  });
  hairline(page, PAGE_H - 68);
}

function drawFooter(page, fonts, pageNum, totalPages, clientName) {
  const y = 32;
  hairline(page, y + 10);
  page.drawText(`${clientName}  ·  Session Packet`, {
    x: MARGIN_X, y, size: 8, font: fonts.regular, color: INK_SOFT,
  });
  const right = `Page ${pageNum} of ${totalPages}`;
  const rightW = fonts.regular.widthOfTextAtSize(right, 8);
  page.drawText(right, {
    x: PAGE_W - MARGIN_X - rightW, y, size: 8, font: fonts.regular, color: INK_SOFT,
  });
}

// ---------------- page 1: this session ----------------
function renderSessionPage(page, fonts, ctx) {
  const { session, notes } = ctx;
  drawHeader(page, fonts, 'Your Session');

  let y = PAGE_H - 95;

  // Title
  page.drawText(session.protocol_name, {
    x: MARGIN_X, y, size: 24, font: fonts.bold, color: INK,
  });
  y -= 26;
  const bandName = BAND_NAMES[session.target_band] || session.target_band;
  page.drawText(bandName, {
    x: MARGIN_X, y, size: 11, font: fonts.italic, color: ACCENT,
  });
  y -= 28;

  // Meta row
  const completedOn = session.completed_at || session.stopped_at || session.started_at;
  const dateStr = completedOn
    ? new Date(completedOn).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      })
    : 'In progress';
  y = drawMetaRow(page, fonts, y, [
    { k: 'Date',       v: dateStr },
    { k: 'Duration',   v: `${session.duration_minutes} minutes` },
    { k: 'Coach',      v: session.coach_staff_name || '—' },
  ]);
  y -= 18;

  // Pre/post bars
  page.drawText('How you felt', {
    x: MARGIN_X, y, size: 13, font: fonts.bold, color: INK,
  });
  y -= 6;
  page.drawText('Before and after your session, on a 1–10 scale.', {
    x: MARGIN_X, y: y - 9, size: 9.5, font: fonts.italic, color: INK_SOFT,
  });
  y -= 28;

  const metrics = [
    { label: 'Stress',  pre: session.pre_stress, post: session.post_stress, reverseGood: true  },
    { label: 'Focus',   pre: session.pre_focus,  post: session.post_focus,  reverseGood: false },
    { label: 'Mood',    pre: session.pre_mood,   post: session.post_mood,   reverseGood: false },
  ];
  for (const m of metrics) {
    y = drawPrePostBar(page, fonts, y, m);
    y -= 8;
  }
  y -= 14;

  // Observations
  if (notes && notes.length) {
    page.drawText('What we observed', {
      x: MARGIN_X, y, size: 13, font: fonts.bold, color: INK,
    });
    y -= 18;
    const observations = notes.map(n => '-  ' + n.display_text).join('    ');
    y = drawText(page, observations, MARGIN_X, y, {
      font: fonts.regular, size: 10, maxWidth: CONTENT_W, lineHeight: 1.6,
    });
  }
}

function drawMetaRow(page, fonts, y, items) {
  const colW = CONTENT_W / items.length;
  for (let i = 0; i < items.length; i++) {
    const x = MARGIN_X + colW * i;
    page.drawText(items[i].k.toUpperCase(), {
      x, y, size: 7.5, font: fonts.mono, color: INK_SOFT,
    });
    page.drawText(String(items[i].v), {
      x, y: y - 13, size: 11, font: fonts.regular, color: INK,
    });
  }
  return y - 28;
}

function drawPrePostBar(page, fonts, y, m) {
  const LABEL_W = 56;
  const BAR_X = MARGIN_X + LABEL_W;
  const BAR_W = CONTENT_W - LABEL_W - 80;
  const BAR_H = 9;

  page.drawText(m.label, {
    x: MARGIN_X, y: y - 7, size: 10.5, font: fonts.regular, color: INK,
  });

  // Background track
  page.drawRectangle({
    x: BAR_X, y: y - BAR_H - 2, width: BAR_W, height: BAR_H,
    color: ACCENT_LT,
  });

  if (m.pre != null && m.post != null) {
    const preFrac  = m.pre  / 10;
    const postFrac = m.post / 10;
    const delta = m.post - m.pre;
    const improved = m.reverseGood ? delta < 0 : delta > 0;

    // Pre marker (open circle)
    const preX = BAR_X + BAR_W * preFrac;
    page.drawCircle({
      x: preX, y: y - BAR_H / 2 - 2, size: 4,
      borderColor: INK_SOFT, borderWidth: 1, color: rgb(1, 1, 1),
    });
    // Post marker (filled, colored by direction)
    const postX = BAR_X + BAR_W * postFrac;
    page.drawCircle({
      x: postX, y: y - BAR_H / 2 - 2, size: 4.5,
      color: delta === 0 ? INK_SOFT : (improved ? POSITIVE : CAUTION),
    });
    // Connecting arrow
    page.drawLine({
      start: { x: preX, y: y - BAR_H / 2 - 2 },
      end:   { x: postX, y: y - BAR_H / 2 - 2 },
      thickness: 1,
      color: delta === 0 ? INK_SOFT : (improved ? POSITIVE : CAUTION),
    });

    // Delta text
    const sign = delta > 0 ? '+' : '';
    const deltaTxt = delta === 0
      ? `${m.pre} -> ${m.post}`
      : `${m.pre} -> ${m.post}  (${sign}${delta})`;
    const col = delta === 0 ? INK_SOFT : (improved ? POSITIVE : CAUTION);
    page.drawText(deltaTxt, {
      x: BAR_X + BAR_W + 10, y: y - 7, size: 10, font: fonts.regular, color: col,
    });
  } else {
    page.drawText('not recorded', {
      x: BAR_X + BAR_W + 10, y: y - 7, size: 9.5, font: fonts.italic, color: INK_SOFT,
    });
  }

  return y - 20;
}

// ---------------- page 2: progress so far ----------------
function renderProgressPage(page, fonts, ctx) {
  const { session, history } = ctx;
  drawHeader(page, fonts, 'Your Progress So Far');

  let y = PAGE_H - 95;

  // history is every completed session for this client, oldest first, INCLUDING current
  const completed = history.filter(s =>
    s.status === 'completed' || s.status === 'stopped_early'
  );

  if (completed.length <= 1) {
    // Baseline frame for first-timers (spec option B)
    page.drawText('This is your baseline.', {
      x: MARGIN_X, y, size: 24, font: fonts.bold, color: INK,
    });
    y -= 36;
    y = drawText(page,
      'Today you gave us a starting point — a snapshot of where your stress, focus, and brain-wave activity are right now. That\'s valuable on its own. But the real story starts with your next session, and the one after that, and the one after that.',
      MARGIN_X, y, { font: fonts.regular, size: 11.5, maxWidth: CONTENT_W, lineHeight: 1.6 });
    y -= 10;
    y = drawText(page,
      'Come back. Bring this packet with you. By your third session, this page will start showing you trends — the places where you\'re growing and the places where we still have work to do.',
      MARGIN_X, y, { font: fonts.regular, size: 11.5, maxWidth: CONTENT_W, lineHeight: 1.6 });
    y -= 14;
    y = drawText(page,
      '"Being confident of this, that he who began a good work in you will carry it on to completion."   — Philippians 1:6',
      MARGIN_X, y, { font: fonts.italic, size: 10, maxWidth: CONTENT_W, lineHeight: 1.5, color: ACCENT });
    y -= 18;

    // Empty chart placeholder with baseline dot
    drawEmptyTrajectoryBox(page, fonts, y - 200, session);
    return;
  }

  // Summary cards
  const sessCount = completed.length;
  const avgStressDelta = avgDelta(completed, 'pre_stress', 'post_stress');
  const avgFocusDelta  = avgDelta(completed, 'pre_focus',  'post_focus');

  y = drawSummaryCards(page, fonts, y, [
    { label: 'Sessions completed', value: String(sessCount), sub: sessCount === 1 ? 'your first' : 'and counting' },
    { label: 'Avg. stress shift',  value: fmtDelta(avgStressDelta), sub: 'lower is better', good: avgStressDelta != null && avgStressDelta < 0 },
    { label: 'Avg. focus shift',   value: fmtDelta(avgFocusDelta),  sub: 'higher is better', good: avgFocusDelta != null && avgFocusDelta > 0 },
  ]);
  y -= 10;

  // Trajectory chart — stress & focus per session
  page.drawText('Your trajectory', {
    x: MARGIN_X, y, size: 13, font: fonts.bold, color: INK,
  });
  y -= 6;
  page.drawText('Each dot is a session. Open circles are your pre-session rating; filled circles are post.', {
    x: MARGIN_X, y: y - 9, size: 9.5, font: fonts.italic, color: INK_SOFT,
  });
  y -= 20;

  y = drawTrajectoryChart(page, fonts, y, completed) - 8;

  // Target band callout
  page.drawRectangle({
    x: MARGIN_X, y: y - 74, width: CONTENT_W, height: 68,
    color: CREAM,
  });
  page.drawText('ABOUT YOUR TARGET BAND', {
    x: MARGIN_X + 14, y: y - 24, size: 8, font: fonts.mono, color: ACCENT,
  });
  const tbName = BAND_NAMES[session.target_band] || session.target_band;
  page.drawText(tbName, {
    x: MARGIN_X + 14, y: y - 42, size: 13, font: fonts.bold, color: INK,
  });
  drawText(page,
    'Your sessions are tuned to develop this band. Over weeks, we expect to see this activity become more accessible to you, even outside of sessions.',
    MARGIN_X + 14, y - 58, { font: fonts.regular, size: 9.5, maxWidth: CONTENT_W - 28, lineHeight: 1.4, color: INK_SOFT });
}

function drawSummaryCards(page, fonts, y, cards) {
  const CARD_W = (CONTENT_W - 16) / 3;
  const CARD_H = 64;
  for (let i = 0; i < cards.length; i++) {
    const x = MARGIN_X + (CARD_W + 8) * i;
    page.drawRectangle({
      x, y: y - CARD_H, width: CARD_W, height: CARD_H,
      borderColor: HAIRLINE, borderWidth: 0.8, color: rgb(1, 1, 1),
    });
    page.drawText(cards[i].label.toUpperCase(), {
      x: x + 10, y: y - 16, size: 7.5, font: fonts.mono, color: INK_SOFT,
    });
    const color = cards[i].good === true  ? POSITIVE
                : cards[i].good === false ? CAUTION
                : INK;
    page.drawText(cards[i].value, {
      x: x + 10, y: y - 38, size: 20, font: fonts.bold, color,
    });
    page.drawText(cards[i].sub, {
      x: x + 10, y: y - 54, size: 8.5, font: fonts.italic, color: INK_SOFT,
    });
  }
  return y - CARD_H - 16;
}

function drawEmptyTrajectoryBox(page, fonts, yTop, session) {
  const H = 160;
  page.drawRectangle({
    x: MARGIN_X, y: yTop - H, width: CONTENT_W, height: H,
    borderColor: HAIRLINE, borderWidth: 0.8, color: CREAM,
  });
  // Baseline dot on left
  page.drawCircle({
    x: MARGIN_X + 50, y: yTop - H / 2, size: 6,
    color: ACCENT,
  });
  page.drawText('Session 1 — today', {
    x: MARGIN_X + 62, y: yTop - H / 2 - 3, size: 10, font: fonts.regular, color: INK,
  });
  // Dotted horizon (ends before the "growth" text to avoid strikethrough)
  for (let xd = MARGIN_X + 160; xd < PAGE_W - MARGIN_X - 130; xd += 6) {
    page.drawCircle({ x: xd, y: yTop - H / 2, size: 0.8, color: INK_SOFT });
  }
  page.drawText('your growth goes here', {
    x: PAGE_W - MARGIN_X - 120, y: yTop - H / 2 - 3, size: 10, font: fonts.italic, color: INK_SOFT,
  });
}

function drawTrajectoryChart(page, fonts, yTop, sessions) {
  const H = 170;
  const x0 = MARGIN_X + 20;
  const x1 = PAGE_W - MARGIN_X - 20;
  const chartW = x1 - x0;
  const yBot = yTop - H;
  // Axis frame
  page.drawLine({ start: { x: x0, y: yTop }, end: { x: x0, y: yBot }, thickness: 0.6, color: HAIRLINE });
  page.drawLine({ start: { x: x0, y: yBot }, end: { x: x1, y: yBot }, thickness: 0.6, color: HAIRLINE });
  // Y-axis gridlines at 0, 5, 10
  for (let v = 0; v <= 10; v += 5) {
    const yy = yBot + (v / 10) * H;
    page.drawLine({
      start: { x: x0, y: yy }, end: { x: x1, y: yy },
      thickness: 0.3, color: HAIRLINE,
    });
    page.drawText(String(v), {
      x: x0 - 14, y: yy - 3, size: 7.5, font: fonts.regular, color: INK_SOFT,
    });
  }

  const N = sessions.length;
  if (N === 0) return yBot - 18;

  const xFor = (i) => x0 + (N === 1 ? chartW / 2 : (chartW * i) / (N - 1));
  const yFor = (v) => yBot + (v / 10) * H;

  // Draw connecting segments for stress (teal)
  const stressPts = sessions.map((s, i) =>
    s.post_stress != null ? { x: xFor(i), y: yFor(s.post_stress), v: s.post_stress } : null
  ).filter(Boolean);
  for (let i = 1; i < stressPts.length; i++) {
    page.drawLine({
      start: stressPts[i - 1], end: stressPts[i],
      thickness: 1.4, color: ACCENT,
    });
  }
  // Focus line (green)
  const focusPts = sessions.map((s, i) =>
    s.post_focus != null ? { x: xFor(i), y: yFor(s.post_focus), v: s.post_focus } : null
  ).filter(Boolean);
  for (let i = 1; i < focusPts.length; i++) {
    page.drawLine({
      start: focusPts[i - 1], end: focusPts[i],
      thickness: 1.4, color: POSITIVE,
    });
  }

  // Dots
  sessions.forEach((s, i) => {
    const x = xFor(i);
    if (s.pre_stress != null) {
      page.drawCircle({ x, y: yFor(s.pre_stress), size: 2.8, borderColor: ACCENT, borderWidth: 0.8, color: rgb(1, 1, 1) });
    }
    if (s.post_stress != null) {
      page.drawCircle({ x, y: yFor(s.post_stress), size: 3, color: ACCENT });
    }
    if (s.pre_focus != null) {
      page.drawCircle({ x, y: yFor(s.pre_focus), size: 2.8, borderColor: POSITIVE, borderWidth: 0.8, color: rgb(1, 1, 1) });
    }
    if (s.post_focus != null) {
      page.drawCircle({ x, y: yFor(s.post_focus), size: 3, color: POSITIVE });
    }
  });

  // X-axis session numbers
  sessions.forEach((s, i) => {
    const label = `#${i + 1}`;
    const w = fonts.mono.widthOfTextAtSize(label, 7.5);
    page.drawText(label, {
      x: xFor(i) - w / 2, y: yBot - 14, size: 7.5, font: fonts.mono, color: INK_SOFT,
    });
  });

  // Legend
  const legY = yBot - 30;
  page.drawCircle({ x: x0, y: legY, size: 3, color: ACCENT });
  page.drawText('Stress', { x: x0 + 7, y: legY - 3, size: 8.5, font: fonts.regular, color: INK });
  const w2 = fonts.regular.widthOfTextAtSize('Stress', 8.5);
  page.drawCircle({ x: x0 + 7 + w2 + 14, y: legY, size: 3, color: POSITIVE });
  page.drawText('Focus', { x: x0 + 7 + w2 + 21, y: legY - 3, size: 8.5, font: fonts.regular, color: INK });

  return yBot - 38;
}

// ---------------- page 3: brain map ----------------
function renderBrainMapPage(page, fonts, ctx) {
  const { session } = ctx;
  drawHeader(page, fonts, 'Understanding Your Brain');

  let y = PAGE_H - 95;

  page.drawText('A quick field guide', {
    x: MARGIN_X, y, size: 24, font: fonts.bold, color: INK,
  });
  y -= 28;
  y = drawText(page,
    'Your brain produces electricity — rhythmic waves in different frequency bands. You have them all, all the time, but they rise and fall depending on what you\'re doing. Training teaches your brain to access the right ones more easily.',
    MARGIN_X, y, { font: fonts.regular, size: 10.5, maxWidth: CONTENT_W, lineHeight: 1.6, color: INK_SOFT });
  y -= 18;

  // Six bands — slowest to fastest
  const order = ['delta', 'theta', 'alpha', 'smr', 'beta', 'gamma'];
  for (const band of order) {
    y = drawBandRow(page, fonts, y, band, band === session.target_band);
    y -= 6;
  }
}

function drawBandRow(page, fonts, y, band, isTarget) {
  const H = 58;
  const boxTop = y;
  const boxBot = y - H;

  if (isTarget) {
    page.drawRectangle({
      x: MARGIN_X - 6, y: boxBot - 2, width: CONTENT_W + 12, height: H,
      color: ACCENT_LT,
    });
    // Target marker
    page.drawRectangle({
      x: MARGIN_X - 6, y: boxBot - 2, width: 3, height: H,
      color: ACCENT,
    });
  }

  page.drawText(BAND_NAMES[band], {
    x: MARGIN_X, y: boxTop - 14, size: 11.5, font: fonts.bold, color: INK,
  });
  if (isTarget) {
    page.drawText('YOUR TARGET', {
      x: PAGE_W - MARGIN_X - 80, y: boxTop - 14, size: 7.5, font: fonts.mono, color: ACCENT,
    });
  }
  drawText(page, BAND_DESCRIPTIONS[band],
    MARGIN_X, boxTop - 28,
    { font: fonts.regular, size: 9.5, maxWidth: CONTENT_W - 10, lineHeight: 1.5, color: INK_SOFT });

  return boxBot - 4;
}

// ---------------- page 4: takeaway ----------------
function renderTakeawayPage(page, fonts, ctx) {
  const { session } = ctx;
  drawHeader(page, fonts, 'Your Takeaway');

  let y = PAGE_H - 95;

  const t = TAKEAWAYS[session.target_band] || TAKEAWAYS.alpha;

  page.drawText('One practice, for this week', {
    x: MARGIN_X, y, size: 11, font: fonts.italic, color: ACCENT,
  });
  y -= 32;
  page.drawText(t.title, {
    x: MARGIN_X, y, size: 26, font: fonts.bold, color: INK,
  });
  y -= 40;

  page.drawText('How to do it', {
    x: MARGIN_X, y, size: 12, font: fonts.bold, color: INK,
  });
  y -= 18;
  t.steps.forEach((step, i) => {
    // Numbered dot
    page.drawCircle({
      x: MARGIN_X + 7, y: y - 4, size: 9, color: ACCENT,
    });
    const num = String(i + 1);
    const numW = fonts.bold.widthOfTextAtSize(num, 9);
    page.drawText(num, {
      x: MARGIN_X + 7 - numW / 2, y: y - 7, size: 9, font: fonts.bold, color: rgb(1, 1, 1),
    });
    y = drawText(page, step, MARGIN_X + 24, y, {
      font: fonts.regular, size: 10.5, maxWidth: CONTENT_W - 24, lineHeight: 1.5,
    });
    y -= 6;
  });

  y -= 10;
  page.drawRectangle({
    x: MARGIN_X, y: y - 90, width: CONTENT_W, height: 86,
    color: CREAM,
  });
  page.drawText('WHY THIS MATTERS', {
    x: MARGIN_X + 14, y: y - 20, size: 8, font: fonts.mono, color: ACCENT,
  });
  drawText(page, t.why, MARGIN_X + 14, y - 36, {
    font: fonts.regular, size: 10, maxWidth: CONTENT_W - 28, lineHeight: 1.55,
  });
  y -= 104;

  // Next session prompt
  hairline(page, y);
  y -= 16;
  page.drawText('NEXT SESSION', {
    x: MARGIN_X, y, size: 8, font: fonts.mono, color: INK_SOFT,
  });
  y -= 16;
  page.drawText('Date: _______________________       Time: _____________', {
    x: MARGIN_X, y, size: 12, font: fonts.regular, color: INK,
  });
  y -= 22;
  y = drawText(page,
    'Bring this packet. We\'ll add to it each visit so you can see your growth on paper.',
    MARGIN_X, y, { font: fonts.italic, size: 10, maxWidth: CONTENT_W, color: INK_SOFT });

  // Small closing — band-specific scripture
  y -= 26;
  drawText(page, t.scripture, MARGIN_X, y, {
    font: fonts.italic, size: 9, maxWidth: CONTENT_W, lineHeight: 1.55, color: INK_SOFT,
  });
}

// ---------------- helpers ----------------
function avgDelta(sessions, preKey, postKey) {
  const deltas = sessions
    .filter(s => s[preKey] != null && s[postKey] != null)
    .map(s => s[postKey] - s[preKey]);
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

function fmtDelta(d) {
  if (d == null) return '—';
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}

// ---------------- entry point ----------------
async function buildPacket({ session, notes, history }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`DreamSonic — Session Packet for ${session.first_name} ${session.last_name_initial}.`);
  doc.setAuthor('DreamSonic');
  doc.setCreator('DreamSonic');
  doc.setProducer('DreamSonic');

  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold:    await doc.embedFont(StandardFonts.HelveticaBold),
    italic:  await doc.embedFont(StandardFonts.HelveticaOblique),
    mono:    await doc.embedFont(StandardFonts.Courier),
  };

  const ctx = { session, notes: notes || [], history: history || [] };
  const clientName = `${session.first_name} ${session.last_name_initial}.`;
  const pages = [
    (p) => renderSessionPage(p, fonts, ctx),
    (p) => renderProgressPage(p, fonts, ctx),
    (p) => renderBrainMapPage(p, fonts, ctx),
    (p) => renderTakeawayPage(p, fonts, ctx),
  ];
  for (let i = 0; i < pages.length; i++) {
    const page = doc.addPage(PageSizes.Letter);
    pages[i](page);
    drawFooter(page, fonts, i + 1, pages.length, clientName);
  }

  return await doc.save();
}

module.exports = { buildPacket };
