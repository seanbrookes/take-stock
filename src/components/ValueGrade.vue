<script setup>
import { computed } from 'vue'
import { ratio } from '../analysis/format.js'
import { humanSector } from '../analysis/valuation.js'
import GradeBadge from './GradeBadge.vue'

/**
 * Valuation grade: A (cheap) to F (expensive), against sector peers.
 *
 * The tooltip carries the raw multiples rather than the percentiles, because a
 * percentile only means something against the peer set while a ratio is
 * something you can take to another source and check.
 */
const props = defineProps({
  /** Normalized by valuationOf(); null when the company has no grade. */
  valuation: { type: Object, default: null },
  /** Distinguishes "no market cap yet" from "no filings". */
  priced: { type: Boolean, default: true },
})

const title = computed(() => {
  const v = props.valuation
  if (!v) {
    return props.priced
      ? 'No valuation multiples available. The cross-source ratios need an SEC filer; most TSX-only companies file PDFs with SEDAR+.'
      : 'No market cap yet — refresh prices.'
  }
  const parts = []
  if (v.pe) parts.push(`P/E ${ratio(v.pe)}`)
  if (v.ps) parts.push(`P/S ${ratio(v.ps)}`)
  if (v.pb) parts.push(`P/B ${ratio(v.pb)}`)
  if (v.pfcf) parts.push(`P/FCF ${ratio(v.pfcf)}`)
  if (v.ev_ebitda) parts.push(`EV/EBITDA ${ratio(v.ev_ebitda)}`)

  return [
    `${v.grade} — cheaper than ${100 - Math.round(v.score)}% of ${humanSector(v.sector)}` +
      (v.peers ? ` (${v.peers} peers)` : ''),
    parts.join(' · '),
    v.factors < 2 ? 'Single factor only — a thin read' : `${v.factors} factors agree`,
  ]
    .filter(Boolean)
    .join('\n')
})
</script>

<template>
  <GradeBadge
    :grade="valuation?.grade ?? null"
    :thin="Boolean(valuation && valuation.factors < 2)"
    :title="title"
  />
</template>
