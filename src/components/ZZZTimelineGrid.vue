<script setup>
import { ref, computed } from 'vue'
// 预留工具库引入
// import { calculateSnapPosition } from '../utils/layoutUtils.js'

const containerRef = ref(null)

// 画布视图状态
const scrollX = ref(0)
const zoom = ref(1)

// 核心常数：1 秒 = 60 逻辑帧 (Tick)
const TICKS_PER_SECOND = 60
// 基础每逻辑帧对应的像素宽度
const BASE_PIXELS_PER_TICK = 2

// 动态计算缩放后的宽度
const scaledTickWidth = computed(() => BASE_PIXELS_PER_TICK * zoom.value)
const scaledSecondWidth = computed(() => TICKS_PER_SECOND * scaledTickWidth.value)

// 动态计算次级刻度步长
const minorStep = computed(() => {
  if (zoom.value >= 2) return 5   // 放大：每 5 tick 一个刻度
  if (zoom.value >= 1) return 10  // 正常：每 10 tick 一个刻度
  return 30                       // 缩小：每 30 tick 一个刻度 (半秒)
})

// 生成刻度线逻辑
const tickMarks = computed(() => {
  const marks = []
  const totalSeconds = 60
  const step = minorStep.value

  for (let s = 0; s <= totalSeconds; s++) {
    // 主刻度：秒级别
    marks.push({
      type: 'major',
      x: s * scaledSecondWidth.value,
      label: `${s}s / ${s * TICKS_PER_SECOND}t`
    })
    
    // 次刻度：基于动态步长生成
    if (s < totalSeconds) {
      for (let t = step; t < TICKS_PER_SECOND; t += step) {
        // 如果放得足够大，可以在次级刻度上也显示具体的 tick 数值，方便排轴
        const showLabel = zoom.value >= 2 && t % 10 === 0 
        marks.push({
          type: 'minor',
          x: s * scaledSecondWidth.value + t * scaledTickWidth.value,
          label: showLabel ? `${s * TICKS_PER_SECOND + t}t` : ''
        })
      }
    }
  }
  return marks
})

// 交互逻辑：平移与缩放
let isDragging = false
let startX = 0

const handleMouseDown = (e) => {
  if (e.button !== 1 && e.button !== 2) return // 仅响应中键/右键拖拽
  isDragging = true
  startX = e.clientX + scrollX.value
}

const handleMouseMove = (e) => {
  if (!isDragging) return
  scrollX.value = Math.max(0, startX - e.clientX)
}

const handleMouseUp = () => {
  isDragging = false
}

const handleWheel = (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    // 缩放范围限制在 0.5x 到 3x
    const zoomDelta = e.deltaY > 0 ? -0.1 : 0.1
    zoom.value = Math.max(0.5, Math.min(10, zoom.value + zoomDelta))
  } else {
    // 水平滚动
    scrollX.value = Math.max(0, scrollX.value + e.deltaY)
  }
}
</script>

<template>
  <div 
    class="zzz-timeline-grid"
    ref="containerRef"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
    @mouseup="handleMouseUp"
    @mouseleave="handleMouseUp"
    @wheel="handleWheel"
  >
    <div class="ruler-header" :style="{ transform: `translateX(${-scrollX}px)` }">
      <div 
        v-for="(mark, index) in tickMarks" 
        :key="index"
        class="ruler-mark"
        :class="`mark-${mark.type}`"
        :style="{ left: `${mark.x}px` }"
      >
        <span v-if="mark.label" class="mark-label">{{ mark.label }}</span>
      </div>
    </div>

    <div class="grid-content" :style="{ transform: `translateX(${-scrollX}px)` }">
      <div 
        v-for="(mark, index) in tickMarks" 
        :key="'line-'+index"
        class="grid-line"
        :class="`line-${mark.type}`"
        :style="{ left: `${mark.x}px` }"
      ></div>
      
      <slot></slot>
    </div>
  </div>
</template>

<style scoped>
.zzz-timeline-grid {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  background-color: #1a1a1c;
  cursor: grab;
}
.zzz-timeline-grid:active {
  cursor: grabbing;
}

.ruler-header {
  height: 30px;
  background-color: #222;
  border-bottom: 1px solid #333;
  position: relative;
  will-change: transform;
}

.ruler-mark {
  position: absolute;
  bottom: 0;
  width: 1px;
}
.mark-major {
  height: 12px;
  background-color: #888;
}
.mark-minor {
  height: 6px;
  background-color: #444;
}
.mark-label {
  position: absolute;
  top: -16px;
  left: 4px;
  font-size: 10px;
  color: #888;
  white-space: nowrap;
  user-select: none;
}

.grid-content {
  height: calc(100% - 30px);
  position: relative;
  will-change: transform;
}
.grid-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
}
.line-major {
  background-color: #333;
}
.line-minor {
  background-color: #222;
}
</style>