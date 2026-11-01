<script setup>
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="wrap">
    <h1>Not found</h1>
    <p class="muted">That page doesn't exist.</p>
    <RouterLink to="/">Back to watchlist</RouterLink>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
  padding: 40px 0;
}
</style>
