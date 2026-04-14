<template>
  <div class="zzz-timeline-canvas" :style="{ '--zoom-factor': zoom }">
    <div class="ruler-bg" :style="{ backgroundSize: `${zoom}px 100%` }"></div>
    
    <div class="single-track">
      <ZZZActionBlock
        v-for="action in actions"
        :key="action.id"
        :action="action"
        :zoom="zoom"
        @updateStartTime="handleUpdateStartTime"
        @updateDuration="handleUpdateDuration"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { ZZZAction } from '../simulation_zzz/types';
import ZZZActionBlock from './ZZZActionBlock.vue';

const props = defineProps<{
  actions: ZZZAction[];
  zoom: number; // 缩放级别，单位：像素/Tick (1/60s)
}>();

const emit = defineEmits(['updateActionData']);

const handleUpdateStartTime = (id: string, newStartTime: number) => {
  emit('updateActionData', { id, field: 'startTime', value: newStartTime });
};

const handleUpdateDuration = (id: string, newDuration: number) => {
  emit('updateActionData', { id, field: 'duration', value: newDuration });
};
</script>

<style scoped>
.zzz-timeline-canvas {
  position: relative;
  width: 100%;
  height: 200px;
  overflow-x: auto;
  background-color: #1e1e1e;
}

.ruler-bg {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  /* 实现 60FPS 强对齐的背景网格 */
  background-image: linear-gradient(to right, #333 1px, transparent 1px);
  pointer-events: none;
}

.single-track {
  position: relative;
  width: max-content;
  min-width: 100%;
  height: 100px;
  margin-top: 50px; /* 为顶部标尺留出空间 */
  background-color: #2a2a2a;
}
</style>