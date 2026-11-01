<script setup>
import { computed } from 'vue'
import { useCompany } from '../../composables/useCompany.js'
import NotesPanel from '../../components/NotesPanel.vue'
import GroupPicker from '../../components/GroupPicker.vue'

const { data } = useCompany()

const symbol = computed(() => data.value?.listing?.symbol ?? data.value?.filer?.ticker ?? '')
const name = computed(
  () => data.value?.submissions?.name ?? data.value?.listing?.description ?? symbol.value,
)
const quote = computed(() => data.value?.quote ?? null)
</script>

<template>
  <div class="stack">
    <div class="row bar">
      <GroupPicker v-if="symbol" :symbol="symbol" />
    </div>

    <NotesPanel
      v-if="symbol"
      :symbol="symbol"
      :name="name"
      :price="quote?.prevDayClosePrice ?? null"
      :market-cap="quote?.marketCap ?? null"
      :currency-code="data?.listing?.currency ?? ''"
    />
  </div>
</template>

<style scoped>
.bar {
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
</style>
