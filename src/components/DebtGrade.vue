<script setup>
import { computed } from 'vue'
import { ratio } from '../analysis/format.js'
import { humanSector } from '../analysis/valuation.js'
import GradeBadge from './GradeBadge.vue'

/**
 * Debt load grade: A (least indebted) to F (most), against sector peers.
 *
 * A is the healthy end, matching the value column — so a row of As reads
 * consistently rather than requiring you to remember which way each letter runs.
 *
 * The "!" is separate from the letter on purpose. The grade is relative, and a
 * sector can be uniformly over-levered; the mark says an absolute threshold was
 * breached whatever the ranking says. Enbridge is the clean example — a normal
 * amount of debt for a pipeline, and objectively over 5x EBITDA.
 */
const props = defineProps({
  /** Normalized by debtOf(); null when there are no filings at all. */
  debt: { type: Object, default: null },
})

const title = computed(() => {
  const d = props.debt
  if (!d) {
    return 'No leverage figures. These need an SEC filer; most TSX-only companies file PDFs with SEDAR+.'
  }
  if (d.excluded) {
    return [
      'Not graded — bank and insurer leverage is not comparable on these metrics.',
      'Deposits are not tagged as debt in XBRL, there is no EBITDA, interest is revenue rather than cost, and the current/non-current split does not apply.',
      'Grading them would rank the most leveraged institutions in the country as the safest.',
    ].join('\n')
  }

  const parts = []
  if (Number.isFinite(d.debt_to_equity)) parts.push(`D/E ${ratio(d.debt_to_equity)}`)
  if (Number.isFinite(d.net_debt_to_ebitda)) {
    parts.push(
      d.net_debt_to_ebitda < 0
        ? `Net cash (${ratio(d.net_debt_to_ebitda)}x EBITDA)`
        : `Net debt/EBITDA ${ratio(d.net_debt_to_ebitda)}`,
    )
  }
  if (Number.isFinite(d.interest_coverage)) parts.push(`Interest cover ${ratio(d.interest_coverage)}`)
  if (Number.isFinite(d.current_ratio)) parts.push(`Current ratio ${ratio(d.current_ratio)}`)

  return [
    `${d.grade} — less indebted than ${100 - Math.round(d.score)}% of ${humanSector(d.sector)}` +
      (d.peers ? ` (${d.peers} peers)` : ''),
    parts.join(' · '),
    d.warning ? `⚠ ${d.warning}` : '',
    d.factors < 2 ? 'Single factor only — a thin read' : `${d.factors} factors agree`,
  ]
    .filter(Boolean)
    .join('\n')
})
</script>

<template>
  <GradeBadge
    :grade="debt?.grade ?? null"
    :thin="Boolean(debt?.grade && debt.factors < 2)"
    :warning="debt?.warning ?? null"
    :excluded="debt?.excluded ?? null"
    :title="title"
  />
</template>
