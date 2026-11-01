<script setup>
/** Uniform loading / error / empty presentation so every view behaves alike. */
defineProps({
  loading: Boolean,
  error: { type: Object, default: null },
  empty: Boolean,
  emptyText: { type: String, default: 'Nothing here yet.' },
  label: { type: String, default: 'Loading…' },
})
defineEmits(['retry'])
</script>

<template>
  <div v-if="loading" class="state">
    <span class="spinner" aria-hidden="true" />
    {{ label }}
  </div>

  <div v-else-if="error" class="state error">
    <p><strong>Could not load data.</strong></p>
    <p class="detail">{{ error.message }}</p>
    <p v-if="error.url" class="detail mono">{{ error.url }}</p>
    <button @click="$emit('retry')">Retry</button>
  </div>

  <div v-else-if="empty" class="state muted">{{ emptyText }}</div>

  <slot v-else />
</template>

<style scoped>
.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 20px;
  text-align: center;
  font-size: 14px;
}

.error {
  border: 1px solid var(--border);
  border-radius: 8px;
}

.detail {
  font-size: 13px;
  opacity: 0.8;
  word-break: break-all;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2s;
  }
}
</style>
