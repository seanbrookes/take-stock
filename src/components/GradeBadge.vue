<script setup>
/**
 * A letter grade, A to F, with its qualifiers.
 *
 * Shared by the value and debt columns so the two read as one system: A is the
 * desirable end of both (cheap; least indebted), the dashed border means the
 * same thin-evidence thing in both, and an em dash means the same absence.
 *
 * Three states beyond the letter itself, each of which a bare dash would hide:
 *
 *  - `thin`     — one factor only. Drawn dashed, because a grade resting on a
 *                 single ratio is a weaker claim than one four ratios agree on.
 *  - `warning`  — an absolute threshold breached, independent of the ranking.
 *                 Being least levered in an over-levered sector is still
 *                 levered, so this rides alongside the letter rather than
 *                 changing it.
 *  - `excluded` — deliberately not graded. Distinct from "no data": a bank's
 *                 debt/equity of 0.00 is present and misleading, not missing.
 */
defineProps({
  grade: { type: String, default: null },
  thin: { type: Boolean, default: false },
  warning: { type: String, default: null },
  excluded: { type: String, default: null },
  title: { type: String, default: '' },
})
</script>

<template>
  <span v-if="excluded" class="badge excluded" :title="title">n/a</span>
  <span v-else-if="grade" class="wrap" :title="title">
    <span class="badge" :class="[`g${grade}`, { thin }]">{{ grade }}</span>
    <span v-if="warning" class="alarm" aria-label="warning">!</span>
  </span>
  <span v-else class="muted" :title="title">—</span>
</template>

<style scoped>
.wrap {
  display: inline-flex;
  gap: 2px;
  align-items: center;
}
.badge {
  display: inline-block;
  min-width: 1.4em;
  padding: 1px 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 0.85em;
  font-weight: 600;
  text-align: center;
}
/* A is the good end of both columns — cheap, and least indebted. */
.badge.gA {
  color: var(--pos);
  border-color: var(--pos);
  background: color-mix(in srgb, var(--pos) 12%, transparent);
}
.badge.gB {
  color: var(--pos);
  border-color: color-mix(in srgb, var(--pos) 45%, transparent);
}
.badge.gC {
  color: var(--text);
  border-color: var(--border);
}
.badge.gD {
  color: var(--neg);
  border-color: color-mix(in srgb, var(--neg) 45%, transparent);
}
.badge.gF {
  color: var(--neg);
  border-color: var(--neg);
  background: color-mix(in srgb, var(--neg) 12%, transparent);
}
.badge.thin {
  border-style: dashed;
  opacity: 0.75;
}
.badge.excluded {
  color: var(--text);
  border-color: var(--border);
  border-style: dashed;
  font-size: 0.75em;
  opacity: 0.7;
}

/* Deliberately not a colour-only signal: the mark is a character, so it
   survives greyscale and sits outside the letter it qualifies. */
.alarm {
  color: #d98324;
  font-weight: 700;
  line-height: 1;
}
</style>
