<template>
  <div
    class="zzz-action-block"
    :style="{
      left: `${action.startTime * zoom}px`,
      width: `${action.duration * zoom}px`,
      backgroundColor: getCharacterColor(action.characterName)
    }"
    @mousedown="startDragBlock"
  >
    <div class="action-info">
      <span class="action-name">{{ action.name }}</span>
    </div>

    <div
      v-for="tick in action.hitTicks"
      :key="tick"
      class="hit-tick-line"
      :style="{ left: `${tick * zoom}px` }"
    ></div>

    <div class="resize-handle right" @mousedown.stop="startResizeDuration"></div>
  </div>
</template>

<script setup lang="ts">
import type { ZZZAction } from '../simulation_zzz/types';

const props = defineProps<{
  action: ZZZAction;
  zoom: number;
}>();

const emit = defineEmits(['updateStartTime', 'updateDuration']);

// 用于视觉区分不同角色
const getCharacterColor = (name: string) => {
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return `hsl(${hash % 360}, 60%, 40%)`;
};

// 交互：在轨道上左右拖拽修改 startTime
const startDragBlock = (e: MouseEvent) => {
  const startX = e.clientX;
  const initialStartTime = props.action.startTime;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const deltaX = moveEvent.clientX - startX;
    const deltaTicks = Math.round(deltaX / props.zoom);
    emit('updateStartTime', props.action.id, Math.max(0, initialStartTime + deltaTicks));
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
};

// 交互：支持边缘拖拽修改 duration
const startResizeDuration = (e: MouseEvent) => {
  const startX = e.clientX;
  const initialDuration = props.action.duration;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const deltaX = moveEvent.clientX - startX;
    const deltaTicks = Math.round(deltaX / props.zoom);
    emit('updateDuration', props.action.id, Math.max(1, initialDuration + deltaTicks));
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
};
</script>

<style scoped>
.zzz-action-block {
  position: absolute;
  top: 10px;
  height: 80px;
  border-radius: 4px;
  border: 1px solid #555;
  box-sizing: border-box;
  cursor: grab;
  user-select: none;
  overflow: hidden;
}

.zzz-action-block:active {
  cursor: grabbing;
}

.action-info {
  padding: 4px;
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.hit-tick-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background-color: #ffeb3b; /* 亮色线条 */
  transform: translateX(-50%);
  pointer-events: none;
}

.resize-handle.right {
  position: absolute;
  top: 0;
  right: 0;
  width: 8px;
  height: 100%;
  cursor: ew-resize;
  background-color: rgba(255, 255, 255, 0.2);
}
.resize-handle.right:hover {
  background-color: rgba(255, 255, 255, 0.5);
}
</style>