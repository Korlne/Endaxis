<script setup>
import { ref, provide, onMounted, onUnmounted, nextTick, computed, watch } from 'vue'
import { refThrottled } from '@vueuse/core'
import { useTimelineStore } from '../stores/timelineStore.js'
import ActionItem from './ActionItem.vue'
import GaugeOverlay from './GaugeOverlay.vue'
import ContextMenu from './ContextMenu.vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'
import { snapMs } from '@/utils/precision.js'

const store = useTimelineStore()
const { t, locale } = useI18n()

// ===================================================================================
// 初始化与常量
// ===================================================================================

const TIME_BLOCK_WIDTH = computed(() => store.timeBlockWidth)
provide('TIME_BLOCK_WIDTH', TIME_BLOCK_WIDTH)

// Refs
const tracksContentRef = ref(null)
const timeRulerWrapperRef = ref(null)
const tracksHeaderRef = ref(null)
const trackLaneRefs = ref([])

// Render State
const svgRenderKey = ref(0)
const scrollbarHeight = ref(0)
const isCursorVisible = ref(false)

// Drag State
const isMouseDown = ref(false)
const isDragStarted = ref(false)
const movingActionId = ref(null)
const movingTrackId = ref(null)
const initialMouseX = ref(0)
const initialMouseY = ref(0)
const dragThreshold = 5
const wasSelectedOnPress = ref(false)
const wasCycleSelectedOnPress = ref(false)
const wasSwitchSelectedOnPress = ref(false)
const dragStartTimes = new Map()
const isAltDown = ref(false)
const isShiftDown = ref(false)
const hoveredContext = ref(null)
const draggingCycleBoundaryId = ref(null)
const draggingSwitchEventId = ref(null)
const dragStartMouseTime = ref(0)

// === 边缘自动滚动相关状态 ===
const autoScrollSpeed = ref(0)
let autoScrollRaf = null
let lastMouseX = 0
const SCROLL_ZONE = 50
const MAX_SCROLL_SPEED = 15

const TRACK_HEIGHT = 50
let resizeObserver = []

// Box Select State
const isBoxSelecting = ref(false)
const boxStart = ref({ x: 0, y: 0 })
const boxRect = ref({ left: 0, top: 0, width: 0, height: 0 })

const draggingTrackOrderIndex = ref(null)
const reorderDropTargetIndex = ref(null)
const isResizingPrep = ref(false)

function onReorderDragStart(evt, index) {
  draggingTrackOrderIndex.value = index
  evt.dataTransfer.effectAllowed = 'move'
  
  const trackInfoEl = evt.target.closest('.track-info')
  if (trackInfoEl) {
    const rect = trackInfoEl.getBoundingClientRect()
    const offsetX = evt.clientX - rect.left
    const offsetY = evt.clientY - rect.top
    evt.dataTransfer.setDragImage(trackInfoEl, offsetX, offsetY)
  }
}

function onReorderDragOver(evt, index) {
  if (draggingTrackOrderIndex.value === null) return
  evt.preventDefault() 
  evt.dataTransfer.dropEffect = 'move'
  reorderDropTargetIndex.value = index
}

function onReorderDrop(evt, targetIndex) {
  evt.preventDefault()
  if (draggingTrackOrderIndex.value !== null && draggingTrackOrderIndex.value !== targetIndex) {
    store.moveTrack(draggingTrackOrderIndex.value, targetIndex)
  }
  resetReorderState()
}

function onReorderDragEnd() {
  resetReorderState()
}

function resetReorderState() {
  draggingTrackOrderIndex.value = null
  reorderDropTargetIndex.value = null
}

function moveTrackUp(index) {
  if (index > 0) store.moveTrack(index, index - 1)
}

function moveTrackDown(index) {
  if (index < store.tracks.length - 1) store.moveTrack(index, index + 1)
}


// ===================================================================================
// 干员选择弹窗逻辑
// ===================================================================================

const isSelectorVisible = ref(false)
const targetTrackIndex = ref(null)
const searchQuery = ref('')
const filterElement = ref('ALL')

const isGameTimeCollapsed = ref(true)
const showGameTime = computed(() => !isGameTimeCollapsed.value || store.isCapturing)
const gridRowHeight = computed(() => showGameTime.value ? '60px' : '48px')

const ELEMENT_FILTERS = computed(() => {
  locale.value
  return [
    { label: t('timelineGrid.elementFilter.all'), value: 'ALL', color: '#888' },
    { label: t('timelineGrid.elementFilter.physical'), value: 'physical', color: '#e0e0e0' },
    { label: t('timelineGrid.elementFilter.blaze'), value: 'blaze', color: '#ff4d4f' },
    { label: t('timelineGrid.elementFilter.cold'), value: 'cold', color: '#00e5ff' },
    { label: t('timelineGrid.elementFilter.emag'), value: 'emag', color: '#ffd700' },
    { label: t('timelineGrid.elementFilter.nature'), value: 'nature', color: '#52c41a' }
  ]
})

function openCharacterSelector(index) {
  targetTrackIndex.value = index
  searchQuery.value = ''
  filterElement.value = 'ALL'
  isSelectorVisible = true
}

function confirmCharacterSelection(charId) {
  if (targetTrackIndex.value !== null) {
    const oldId = store.tracks[targetTrackIndex.value].id
    store.changeTrackOperator(targetTrackIndex.value, oldId, charId)
  }
  isSelectorVisible.value = false
}

function removeOperator() {
  if (targetTrackIndex.value !== null) {
    store.clearTrack(targetTrackIndex.value)
  }
  isSelectorVisible.value = false
}

const filteredListFlat = computed(() => {
  let list = store.characterRoster || []
  if (filterElement.value !== 'ALL') {
    list = list.filter(c => c.element === filterElement.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(c => c.name.toLowerCase().includes(q))
  }
  return list.sort((a, b) => (b.rarity || 0) - (a.rarity || 0))
})

const rosterByRarity = computed(() => {
  const groups = {}
  filteredListFlat.value.forEach(char => {
    const r = char.rarity || 1
    if (!groups[r]) groups[r] = []
    groups[r].push(char)
  })
  const levels = Object.keys(groups).map(Number).sort((a, b) => b - a)
  return levels.map(level => ({ level: level, list: groups[level] }))
})

function getRarityBaseColor(rarity) {
  if (rarity === 6) return '#FFD700'
  if (rarity === 5) return '#ffc400'
  if (rarity === 4) return '#d8b4fe'
  return '#a0a0a0'
}

// ===================================================================================
// 核心逻辑：操作轴计算
// ===================================================================================

const operationMarkers = computed(() => {
  let rawMarkers = []

  store.tracks.forEach((track, index) => {
    if (!track.id) return
    const keyNum = index + 1

    track.actions.forEach(action => {
      if ((action.triggerWindow || 0) < 0) return

      let label = '', isHold = false, customClass = ''
      if (action.type === 'skill') {
        label = `${keyNum}`; customClass = 'op-skill'
      } else if (action.type === 'link') {
        label = 'E'; customClass = 'op-link'
      } else if (action.type === 'ultimate') {
        label = `${keyNum} (Hold)`; isHold = true; customClass = 'op-ultimate'
      } else return

      rawMarkers.push({
        id: `op-${action.instanceId}`,
        left: store.timeToPx(action.startTime || 0),
        width: isHold ? null : 24,
        right: store.timeToPx(action.startTime || 0) + (isHold ? (store.timeToPx((action.startTime || 0) + (action.duration || 0)) - store.timeToPx(action.startTime || 0)) : 24),
        label, isHold, customClass,
        top: 0, height: 14, fontSize: 9
      })
    })

    const mySwitchEvents = (store.switchEvents || []).filter(sw => sw.characterId === track.id)

    mySwitchEvents.forEach(sw => {
      rawMarkers.push({
        id: `op-sw-${sw.id}`,
        left: store.timeToPx(sw.time),
        width: 24,
        right: store.timeToPx(sw.time) + 24,
        label: `F${keyNum}`,
        isHold: false,
        customClass: 'op-switch',
        top: 0, height: 14, fontSize: 9
      })
    })
  })

  rawMarkers.sort((a, b) => a.left - b.left)
  const finalMarkers = []
  let cluster = []
  let clusterMaxRight = -1
  const processCluster = (group) => {
    if (group.length === 0) return
    const levels = []
    group.forEach(m => {
      let placed = false
      for (let i = 0; i < levels.length; i++) {
        if (levels[i] + 1 <= m.left) { m.rowIndex = i; levels[i] = m.right; placed = true; break }
      }
      if (!placed) { m.rowIndex = levels.length; levels.push(m.right) }
    })
    const depth = levels.length
    let h, step, fs
    if (depth <= 2) { h = 14; step = 16; fs = 9; }
    else if (depth === 3) { h = 12; step = 13; fs = 9; }
    else { h = 10; step = 10; fs = 8; }
    group.forEach(m => { m.height = h; m.top = m.rowIndex * step; m.fontSize = fs; finalMarkers.push(m) })
  }
  rawMarkers.forEach(m => {
    if (cluster.length === 0) { cluster.push(m); clusterMaxRight = m.right } else {
      if (m.left < clusterMaxRight) { cluster.push(m); clusterMaxRight = Math.max(clusterMaxRight, m.right) } else { processCluster(cluster); cluster = [m]; clusterMaxRight = m.right }
    }
  })
  processCluster(cluster)
  return finalMarkers
})

// ===================================================================================
// 辅助计算属性 & 事件处理
// ===================================================================================

const totalWidthComputed = computed(() => {
  return store.totalTimelineWidthPx
})

const prepZoneWidthPxRounded = computed(() => Math.round(store.prepZoneWidthPx))

const transformStyle = computed(() => {
  return {
    transform: `translateX(${-store.timelineShift}px)`,
    willChange: 'transform'
  }
})

const getTrackLaneStyle = computed(() => {
  const w = TIME_BLOCK_WIDTH.value
  const totalWidth = totalWidthComputed.value

  return {
    width: `${totalWidth}px`,
    backgroundImage: `linear-gradient(90deg, rgba(255, 255, 255, 0.08) 1px, transparent 0)`,
    backgroundSize: `${w}px 100%`,
    backgroundRepeat: 'repeat-x',
    imageRendering: 'auto'
  }
})

function getViewWindow({ bufferPx = 0 } = {}) {
  const totalPx = store.totalTimelineWidthPx;
  const totalSeconds = store.viewDuration;

  if (!tracksContentRef.value || store.isCapturing) {
    return {
      startPx: 0,
      endPx: totalPx,
      startTime: 0,
      endTime: totalSeconds
    }
  }

  const timelineWidth = store.timelineRect.width;
  const scrollLeft = store.timelineShift;

  const startPx = Math.max(scrollLeft - bufferPx, 0);
  const endPx = Math.min(scrollLeft + timelineWidth + bufferPx, totalPx);

  return {
    startPx,
    endPx,
    startTime: store.pxToTime(startPx),
    endTime: store.pxToTime(endPx)
  }
}

const rawDynamicTicks = computed(() => {
  const width = TIME_BLOCK_WIDTH.value;
  const viewWindow = getViewWindow({ bufferPx: 100 });

  const prep = store.prepDuration || 0
  const realStartVT = viewWindow.startTime;
  const realEndVT = viewWindow.endTime;

  const btStart = realStartVT - prep
  const btEnd = realEndVT - prep

  const gameStartVT = store.toGameTime(realStartVT);
  const gameStartBT = gameStartVT - prep

  let subDivision = 1;
  if (width >= 800) subDivision = 60;
  else if (width >= 200) subDivision = 10;
  else if (width >= 100) subDivision = 2;

  const minBtForTicks = (!store.prepExpanded && prep > 0) ? 0 : Math.min(btStart, gameStartBT)
  const startStep = Math.floor(minBtForTicks * subDivision);
  const endStep = Math.ceil(btEnd * subDivision);

  const realTicks = [];
  const gameTicks = [];

  for (let i = startStep; i <= endStep; i++) {
    const bt = i / subDivision;
    let type = '';
    let label = '';
    const isIntegerSecond = (i % subDivision === 0);

    if (isIntegerSecond) {
      const secondValue = Math.round(bt);
      const isFiveSec = secondValue % 5 === 0;
      const showAllLabels = width >= 100;

      if (showAllLabels || isFiveSec) {
        type = 'major';
        label = `${secondValue}s`;
      } else {
        type = 'major-dim';
      }

    } else {
      if (subDivision === 2) {
        type = 'tenth';
      } else if (subDivision === 10) {
        type = 'tenth';
        if (width >= 500) label = `.${Math.round((bt % 1) * 10)}`;
      } else if (subDivision === 60) {
        const frameIdx = i % 60;
        if (frameIdx % 10 === 0 && frameIdx !== 0) {
          type = 'tenth';
          if (width >= 600) label = `${frameIdx}f`;
        } else if (frameIdx % 2 === 0) {
          type = 'frame';
        } else {
          if (width < 1000) continue;
          type = 'frame';
        }
      } else {
        continue;
      }
    }

    const realVT = bt + prep
    if (!store.prepExpanded && prep > 0 && bt < -0.0001) {
      continue
    }
    const realX = store.timeToPx(realVT)

    realTicks.push({
      time: bt,
      type,
      label,
      x: realX
    });

    const gameVT = bt + prep
    const mappedRealVT = store.toRealTime(gameVT);

    if (mappedRealVT >= realStartVT && mappedRealVT <= realEndVT) {
      gameTicks.push({
        time: bt,
        type,
        label,
        x: store.timeToPx(mappedRealVT)
      });
    }
  }

  return { realTicks, gameTicks };
});

const dynamicTicks = refThrottled(rawDynamicTicks, 100);

function forceSvgUpdate() { svgRenderKey.value++ }

function updateScrollbarHeight() {
  if (tracksContentRef.value) {
    const el = tracksContentRef.value
    const height = el.offsetHeight - el.clientHeight
    scrollbarHeight.value = height > 0 ? height : 0
  }
}

function calculateTimeFromEvent(evt, fixedStep = null) {
  const mouseXInTrack = store.toTimelineSpace(evt.clientX, evt.clientY).x
  const rawTime = store.pxToTime(mouseXInTrack)
  const step = fixedStep !== null ? fixedStep : store.snapStep
  const inverse = 1 / step
  let startTime = Math.round(rawTime * inverse) / inverse
  if (startTime < 0) startTime = 0
  return startTime
}

function onPrepResizeMouseDown(evt) {
  if (!store.prepExpanded) return
  if (store.prepDuration <= 0) return
  evt.stopPropagation()
  evt.preventDefault()
  isResizingPrep.value = true
  document.body.classList.add('is-dragging')
  window.addEventListener('mousemove', onPrepResizeMouseMove)
  window.addEventListener('mouseup', onPrepResizeMouseUp)
}

function onPrepResizeMouseMove(evt) {
  if (!isResizingPrep.value) return
  const newDuration = calculateTimeFromEvent(evt, store.snapStep)
  store.setPrepDuration(newDuration, { commit: false })
}

function onPrepResizeMouseUp() {
  if (!isResizingPrep.value) return
  isResizingPrep.value = false
  store.commitState()
  document.body.classList.remove('is-dragging')
  window.removeEventListener('mousemove', onPrepResizeMouseMove)
  window.removeEventListener('mouseup', onPrepResizeMouseUp)
}

const isPrepDurationEditorOpen = ref(false)
const prepDurationDraft = ref('')
const prepDurationInputRef = ref(null)

function openPrepDurationEditor() {
  prepDurationDraft.value = String(Number(store.prepDuration) || 0)
  isPrepDurationEditorOpen.value = true
  nextTick(() => prepDurationInputRef.value?.focus?.())
}

function closePrepDurationEditor() {
  isPrepDurationEditorOpen.value = false
}

function applyPrepDurationDraft() {
  const v = Number(prepDurationDraft.value)
  if (!Number.isFinite(v)) return
  store.setPrepDuration(v)
  closePrepDurationEditor()
}

const fakeScrollbarRef = ref(null)

let ticking = false
function onFakeScroll(e) {
  if (ticking) return
  ticking = true
  store.setTimelineShift(e.target.scrollLeft)
  requestAnimationFrame(() => {
    ticking = false
  })
}

watch(() => store.timelineShift, (val) => {
  if (fakeScrollbarRef.value) {
    fakeScrollbarRef.value.scrollLeft = val
  }
})

watch(() => store.timelineScrollTop, (val) => {
  if (tracksHeaderRef.value) {
    tracksHeaderRef.value.scrollTop = val
  }
  if (tracksContentRef.value && Math.abs(tracksContentRef.value.scrollTop - val) > 1) {
    tracksContentRef.value.scrollTop = val
  }
})

function syncVerticalScroll() {
  if (tracksContentRef.value) {
    const top = tracksContentRef.value.scrollTop
    store.setScrollTop(top)
  }
}


function onActionContextMenu(evt, action) {
  if (!store.multiSelectedIds.has(action.instanceId)) {
    store.selectAction(action.instanceId)
  }
  store.openContextMenu(evt, action.instanceId)
}
// ===================================================================================
// 鼠标与拖拽逻辑
// ===================================================================================

const cachedSpData = computed(() => store.calculateGlobalSpData())
const currentSpValue = computed(() => {
  const time = store.cursorCurrentTime
  const points = cachedSpData.value
  if (!points || points.length === 0) {
    const val = Number(store.systemConstants.initialSp)
    return isNaN(val) ? 200 : val
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]; const p2 = points[i+1]
    if (time >= p1.time && time < p2.time) {
      const progress = (time - p1.time) / (p2.time - p1.time)
      const val = p1.sp + (p2.sp - p1.sp) * progress
      return Math.floor(val)
    }
  }
  return Math.floor(points[points.length - 1].sp)
})

const cachedStaggerData = computed(() => store.calculateGlobalStaggerData().points)
const currentStaggerValue = computed(() => {
  const time = store.cursorCurrentTime
  const points = cachedStaggerData.value
  if (!points || points.length === 0) return 0
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]
    const p2 = points[i+1]
    if (time >= p1.time && time < p2.time) {
      return Math.floor(p1.val)
    }
  }
  return Math.floor(points[points.length - 1].val)
})

function getStepPointAtTime(points, time) {
  if (!points || points.length === 0) return null

  let lo = 0
  let hi = points.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((Number(points[mid].time) || 0) <= time) lo = mid + 1
    else hi = mid - 1
  }

  return points[Math.max(0, hi)] || null
}

function toMutedRgba(color, alpha = 0.78) {
  const c = String(color || '').trim()
  if (!c) return `rgba(255,255,255,${alpha})`

  if (c.startsWith('#')) {
    const hex = c.slice(1)
    const expanded = (hex.length === 3)
      ? hex.split('').map(ch => ch + ch).join('')
      : hex

    if (expanded.length === 6) {
      const r = parseInt(expanded.slice(0, 2), 16)
      const g = parseInt(expanded.slice(2, 4), 16)
      const b = parseInt(expanded.slice(4, 6), 16)
      if ([r, g, b].every(Number.isFinite)) return `rgba(${r},${g},${b},${alpha})`
    }
  }

  return c
}

const cursorGaugeRows = computed(() => {
  const time = snapMs(store.cursorCurrentTime)
  const rows = []

  for (const track of store.teamTracksInfo) {
    if (!track?.id) continue

    const points = store.gaugeSeriesByTrackId.get(track.id) || []
    const point = getStepPointAtTime(points, time)
    const val = snapMs(point?.val ?? 0)

    const max = store.getTrackGaugeMax(track.id)
    const baseColor = store.getCharacterElementColor(track.id)
    const isFull = max > 0 && val >= max - 1e-9
    const colorMuted = toMutedRgba(baseColor, 0.78)
    const colorFull = toMutedRgba(baseColor, 1)

    rows.push({
      id: track.id,
      name: track.name,
      isFull,
      color: isFull ? colorFull : colorMuted,
      colorMuted,
      colorFull,
      val,
      max,
    })
  }

  return rows
})

function onGridMouseMove(evt) {
  store.setCursorPosition(evt.clientX, evt.clientY)
  isCursorVisible.value = true
}
function onGridMouseLeave() { isCursorVisible.value = false }

function onContentMouseDown(evt) {
  if (store.isBoxSelectMode) {
    evt.stopPropagation(); evt.preventDefault()
    isBoxSelecting.value = true
    boxStart.value = store.toTimelineSpace(evt.clientX, evt.clientY)
    boxRect.value = { left: boxStart.value.x, top: boxStart.value.y, width: 0, height: 0 }
    window.addEventListener('mousemove', onBoxMouseMove)
    window.addEventListener('mouseup', onBoxMouseUp)
    return
  }
  onBackgroundClick(evt)
}

function onCycleLineMouseDown(evt, boundaryId) {
  evt.stopPropagation()
  wasCycleSelectedOnPress.value = (store.selectedCycleBoundaryId === boundaryId)
  if (!wasCycleSelectedOnPress.value) {
    store.selectCycleBoundary(boundaryId)
  }
  draggingCycleBoundaryId.value = boundaryId
  initialMouseX.value = evt.clientX
  initialMouseY.value = evt.clientY
  isDragStarted.value = false
  isMouseDown.value = true
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
}

function onBoxMouseMove(evt) {
  if (!isBoxSelecting.value) return
  const current = store.toTimelineSpace(evt.clientX, evt.clientY)
  const left = Math.min(boxStart.value.x, current.x)
  const top = Math.min(boxStart.value.y, current.y)
  boxRect.value = {
    left, top,
    width: Math.abs(current.x - boxStart.value.x),
    height: Math.abs(current.y - boxStart.value.y)
  }
}

function onBoxMouseUp() {
  isBoxSelecting.value = false
  window.removeEventListener('mousemove', onBoxMouseMove)
  window.removeEventListener('mouseup', onBoxMouseUp)
  const box = boxRect.value
  const selection = {
    left: box.width > 0 ? box.left : box.left + box.width,
    top: box.height > 0 ? box.top : box.top + box.height,
    right: box.width > 0 ? box.left + box.width : box.left,
    bottom: box.height > 0 ? box.top + box.height : box.top
  }
  if (selection.left > selection.right) [selection.left, selection.right] = [selection.right, selection.left]
  if (selection.top > selection.bottom) [selection.top, selection.bottom] = [selection.bottom, selection.top]
  const foundIds = []
  store.tracks.forEach((track, trackIndex) => {
    const trackEl = document.getElementById(`track-row-${trackIndex}`)
    if (!trackEl) return
    const trackRect = trackEl.getBoundingClientRect()
    const containerRect = store.timelineRect
    const trackRelativeTop = (trackRect.top - containerRect.top) + store.timelineScrollTop
    const trackRelativeBottom = trackRelativeTop + trackRect.height
    if (trackRelativeBottom < selection.top || trackRelativeTop > selection.bottom) return
    track.actions.forEach(action => {
      const endTime = store.getShiftedEndTime(action.startTime, action.duration, action.instanceId)
      const startPixel = store.timeToPx(action.startTime)
      const endPixel = store.timeToPx(endTime)
      if (startPixel < selection.right && endPixel > selection.left) foundIds.push(action.instanceId)
    })
  })
  if (foundIds.length > 0) { store.setMultiSelection(foundIds); ElMessage.success(t('timelineGrid.selection.selectedCount', { count: foundIds.length })) }
  else { store.clearSelection() }
  boxRect.value = { left: 0, top: 0, width: 0, height: 0 }
}

// ===================================================================================
// 缩放逻辑
// ===================================================================================

const zoomValue = computed({
  get: () => store.timeBlockWidth,
  set: (val) => store.setBaseBlockWidth(val)
})

function adjustZoom(delta, anchorTime = null) {
  const oldWidth = store.timeBlockWidth
  if (anchorTime === null) {
    const viewportCenterX = store.timelineShift + store.timelineRect.width / 2
    anchorTime = store.pxToTime(viewportCenterX)
  }
  const anchorOffsetInViewport = store.timeToPx(anchorTime) - store.timelineShift
  const newVal = oldWidth + delta
  store.setBaseBlockWidth(newVal)
  const newScrollLeft = store.timeToPx(anchorTime) - anchorOffsetInViewport
  nextTick(() => {
    store.setTimelineShift(newScrollLeft)
  })
}
function handleWheel(e) {
  if (e.ctrlKey) {
    e.preventDefault()
    const timeAtMouse = store.cursorCurrentTime
    const zoomSpeed = 0.15
    const direction = e.deltaY < 0 ? 1 : -1
    const delta = Math.round(store.timeBlockWidth * zoomSpeed * direction)
    adjustZoom(delta, timeAtMouse)
  }
}

function handleTrackWheel(e) {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => { ticking = false })

  if (e.ctrlKey) { handleWheel(e); return }
  if (Math.abs(e.deltaX) > 0 || e.shiftKey) {
    e.preventDefault()
    let delta = e.deltaX
    if (e.shiftKey && delta === 0) delta = e.deltaY
    const newLeft = store.timelineShift + delta
    store.setTimelineShift(newLeft)
  }
}

// ===================================================================================
// 对齐辅助线逻辑
// ===================================================================================

const alignGuide = ref({
  visible: false,
  x: 0,
  top: 0,
  height: 0,
  label: '',
  type: '', // 'snap' | 'align'
  color: '',
  targetRect: null
})

function updateAlignGuide(evt, action) {
  hoveredContext.value = { action, clientX: evt.clientX }

  if (!isAltDown.value || !store.selectedActionId || store.selectedActionId === action.instanceId) {
    alignGuide.value.visible = false
    return
  }

  const actionLayout = store.getNodeRect(action.instanceId)
  if (!actionLayout) return

  const rect = actionLayout.rect
  const relLeft = rect.left
  const relTop = rect.top
  const mouseX = store.toTimelineSpace(evt.clientX, evt.clientY).x
  const clickX = mouseX - rect.left
  const isClickLeft = clickX < (rect.width / 2)
  const isShift = isShiftDown.value

  let guideX = 0
  let label = ''
  let type = ''
  let color = ''
  let iconKey = ''

  if (!isShift) {
    type = 'snap'
    color = '#00e5ff'
    if (isClickLeft) {
      guideX = relLeft
      label = t('timelineGrid.alignGuide.snapFront')
      iconKey = 'snap-left'
    } else {
      guideX = relLeft + rect.width
      label = t('timelineGrid.alignGuide.snapBack')
      iconKey = 'snap-right'
    }
  } else {
    type = 'align'
    color = '#ff00ff'
    if (isClickLeft) {
      guideX = relLeft
      label = t('timelineGrid.alignGuide.alignLeft')
      iconKey = 'align-left'
    } else {
      guideX = relLeft + rect.width
      label = t('timelineGrid.alignGuide.alignRight')
      iconKey = 'align-right'
    }
  }

  alignGuide.value = {
    visible: true,
    x: guideX,
    top: relTop,
    height: rect.height,
    label,
    iconKey,
    type,
    color,
    targetRect: { left: relLeft, top: relTop, width: rect.width, height: rect.height }
  }
}

function hideAlignGuide() {
  alignGuide.value.visible = false
  hoveredContext.value = null
}

function recalcAlignGuide() {
  if (hoveredContext.value) {
    const { action, clientX } = hoveredContext.value
    updateAlignGuide({ clientX }, action)
  }
}

function onBackgroundContextMenu(evt) {
  evt.preventDefault()
  if (isBoxSelecting.value || isDragStarted.value) return
  const cursorPos = store.toTimelineSpace(evt.clientX, evt.clientY)
  const rawTime = store.pxToTime(cursorPos.x)
  const snap = store.snapStep
  let clickTime = Math.round(rawTime / snap) * snap
  clickTime = snapMs(Math.max(0, clickTime))
  store.openContextMenu(evt, null, clickTime)
}

function onActionMouseDown(evt, track, action) {
  evt.stopPropagation()
  if (action.isLocked) {
    if (evt.button === 0) {
      store.selectAction(action.instanceId)
      ElMessage.warning({ message: t('timelineGrid.action.locked'), duration: 1000, grouping: true })
      return
    }
  }

  const actionLayout = store.getNodeRect(action.instanceId)
  if (!actionLayout) return

  const mousePos = store.toTimelineSpace(evt.clientX, evt.clientY)

  if (isAltDown.value) {
    if (store.selectedActionId && store.selectedActionId !== action.instanceId) {
      const rect = actionLayout.rect
      const clickX = mousePos.x - rect.left
      const isClickLeft = clickX < (rect.width / 2)
      const isShift = isShiftDown.value

      let alignMode = ''
      let msg = ''

      if (!isShift) {
        if (isClickLeft) { alignMode = 'RL'; msg = t('timelineGrid.alignResult.snappedFront') }
        else { alignMode = 'LR'; msg = t('timelineGrid.alignResult.snappedBack') }
      } else {
        if (isClickLeft) { alignMode = 'LL'; msg = t('timelineGrid.alignResult.alignedLeft') }
        else { alignMode = 'RR'; msg = t('timelineGrid.alignResult.alignedRight') }
      }

      const success = store.alignActionToTarget(action.instanceId, alignMode)
      if (success) {
        ElMessage.success(msg)
        hideAlignGuide()
      } else {
        ElMessage.warning(t('timelineGrid.alignResult.unchanged'))
      }
    }
    return
  }

  if (evt.button !== 0) return

  setTimeout(() => {
    wasSelectedOnPress.value = store.multiSelectedIds.has(action.instanceId)

    if (!store.multiSelectedIds.has(action.instanceId)) {
      store.selectAction(action.instanceId)
    }

    isMouseDown.value = true
    isDragStarted.value = false
    movingActionId.value = action.instanceId
    movingTrackId.value = track.id
    initialMouseY.value = evt.clientY

    dragStartTimes.clear()
    store.tracks.forEach(t => {
      t.actions.forEach(a => {
        if (a.logicalStartTime === undefined) a.logicalStartTime = a.startTime
        dragStartTimes.set(a.instanceId, a.logicalStartTime)
      })
    })

    initialMouseX.value = evt.clientX
    dragStartMouseTime.value = store.pxToTime(mousePos.x)

    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
    window.addEventListener('blur', onWindowMouseUp)
  }, 0)
}

function updateDragPosition(clientX) {
  if (!isDragStarted.value || !movingActionId.value) return;

  const timelineX = store.toTimelineSpace(clientX, initialMouseY.value).x
  const mouseTime = store.pxToTime(timelineX)
  const deltaTime = mouseTime - dragStartMouseTime.value

  const selectedIds = store.multiSelectedIds;
  const snap = store.snapStep;

  store.tracks.forEach(t => {
    t.actions.forEach(a => {
      if (selectedIds.has(a.instanceId) && !a.isLocked) {
        const orgLogical = dragStartTimes.get(a.instanceId);
        const targetTime = orgLogical + deltaTime;
        let snappedTime = Math.round(targetTime / snap) * snap;
        a.logicalStartTime = Math.max(0, snapMs(snappedTime));
      }
    });
  });

  store.refreshAllActionShifts();
  nextTick(() => svgRenderKey.value++);
}

function performAutoScroll() {
  if (autoScrollSpeed.value === 0) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = null
    return
  }
  const newShift = store.timelineShift + autoScrollSpeed.value
  store.setTimelineShift(newShift)
  updateDragPosition(lastMouseX)
  autoScrollRaf = requestAnimationFrame(performAutoScroll)
}

function onSwitchMarkerMouseDown(evt, id) {
  evt.stopPropagation()
  evt.preventDefault()
  if (evt.button !== 0) return

  wasSwitchSelectedOnPress.value = (store.selectedSwitchEventId === id)
  if (!wasSwitchSelectedOnPress.value) {
    store.selectSwitchEvent(id)
  }
  draggingSwitchEventId.value = id
  initialMouseX.value = evt.clientX
  initialMouseY.value = evt.clientY
  isDragStarted.value = false
  isMouseDown.value = true

  document.body.classList.add('is-dragging')
  window.addEventListener('mousemove', onWindowMouseMove)
  window.addEventListener('mouseup', onWindowMouseUp)
  window.addEventListener('blur', onWindowMouseUp)
}

function onWindowMouseMove(evt) {
  if (draggingSwitchEventId.value) {
    if (!isDragStarted.value) {
      const dist = Math.sqrt(Math.pow(evt.clientX - initialMouseX.value, 2) + Math.pow(evt.clientY - initialMouseY.value, 2))
      if (dist > dragThreshold) isDragStarted.value = true; else return
    }
    let newTime = calculateTimeFromEvent(evt, store.snapStep)
    if (newTime > store.viewDuration) newTime = store.viewDuration
    newTime = snapMs(newTime)
    store.updateSwitchEvent(draggingSwitchEventId.value, newTime)
    return
  }
  
  if (draggingCycleBoundaryId.value) {
    if (!isDragStarted.value) {
      const dist = Math.sqrt(Math.pow(evt.clientX - initialMouseX.value, 2) + Math.pow(evt.clientY - initialMouseY.value, 2))
      if (dist > dragThreshold) isDragStarted.value = true; else return
    }
    let newTime = calculateTimeFromEvent(evt, store.snapStep)
    if (newTime > store.viewDuration) newTime = store.viewDuration
    newTime = snapMs(newTime)
    store.updateCycleBoundary(draggingCycleBoundaryId.value, newTime)
    return
  }

  if (!isMouseDown.value) return
  if (evt.buttons === 0) { onWindowMouseUp(evt); return }
  const target = evt.target
  const isForm = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  const isSidebar = target && (target.closest('.properties-sidebar') || target.closest('.action-library'))
  if (isForm || isSidebar) { onWindowMouseUp(evt); return }

  if (!isDragStarted.value) {
    const dist = Math.sqrt(Math.pow(evt.clientX - initialMouseX.value, 2) + Math.pow(evt.clientY - initialMouseY.value, 2))
    if (dist > dragThreshold) isDragStarted.value = true; else return
  }

  lastMouseX = evt.clientX
  if (tracksContentRef.value) {
    const rect = store.timelineRect
    if (evt.clientX < rect.left + SCROLL_ZONE) {
      const ratio = 1 - (Math.max(0, evt.clientX - rect.left) / SCROLL_ZONE)
      autoScrollSpeed.value = -Math.max(2, ratio * MAX_SCROLL_SPEED)
    }
    else if (evt.clientX > rect.right - SCROLL_ZONE) {
      const ratio = 1 - (Math.max(0, rect.right - evt.clientX) / SCROLL_ZONE)
      autoScrollSpeed.value = Math.max(2, ratio * MAX_SCROLL_SPEED)
    }
    else {
      autoScrollSpeed.value = 0
    }
    if (autoScrollSpeed.value !== 0 && !autoScrollRaf) {
      performAutoScroll()
    }
  }

  if (autoScrollSpeed.value === 0) {
    updateDragPosition(evt.clientX)
  }
}

function onWindowMouseUp(event) {
  autoScrollSpeed.value = 0
  if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null }

  if (draggingSwitchEventId.value) {
    if (!isDragStarted.value && wasSwitchSelectedOnPress.value) {
      store.selectSwitchEvent(draggingSwitchEventId.value)
    }
    if (isDragStarted.value) store.commitState()
    isDragStarted.value = false
    draggingSwitchEventId.value = null
    document.body.classList.remove('is-dragging')
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    window.removeEventListener('blur', onWindowMouseUp)
    isMouseDown.value = false
    return
  }

  if (draggingCycleBoundaryId.value) {
    if (!isDragStarted.value && wasCycleSelectedOnPress.value) {
      store.selectCycleBoundary(draggingCycleBoundaryId.value)
    }
    if (isDragStarted.value) store.commitState()
    isDragStarted.value = false
    draggingCycleBoundaryId.value = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    window.removeEventListener('blur', onWindowMouseUp)
    isMouseDown.value = false
    return
  }

  const _wasDragging = isDragStarted.value
  try {
    if (!isDragStarted.value && movingActionId.value) {
      if (store.selectedAnomalyId) {
        store.setSelectedAnomalyId(null)
      } else if (wasSelectedOnPress.value) {
        store.selectAction(movingActionId.value)
      }
    } else if (_wasDragging) { store.commitState() }
  } catch (error) { console.error("MouseUp Error:", error) } finally {
    dragStartTimes.clear()
    isMouseDown.value = false; isDragStarted.value = false; movingActionId.value = null; movingTrackId.value = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
    window.removeEventListener('blur', onWindowMouseUp)
  }
  if (_wasDragging) window.addEventListener('click', captureClick, {capture: true, once: true})
}

function captureClick(e) { e.stopPropagation(); e.preventDefault() }

function calculateTimeFromDropEvent(evt, skill, fixedStep = null) {
  const offsetX = Number(skill?.dragOffsetX) || 0
  const mouseXInTrack = store.toTimelineSpace((evt?.clientX || 0) - offsetX, evt?.clientY || 0).x
  const rawTime = store.pxToTime(mouseXInTrack)
  const step = fixedStep !== null ? fixedStep : store.snapStep
  const inverse = 1 / step
  let startTime = Math.round(rawTime * inverse) / inverse
  if (startTime < 0) startTime = 0
  return startTime
}

function onTrackDrop(track, evt) {
  const skill = store.draggingSkillData; if (!skill || store.activeTrackId !== track.id) return
  const startTime = calculateTimeFromDropEvent(evt, skill)
  store.addSkillToTrack(track.id, skill, startTime)
  nextTick(() => forceSvgUpdate())
}
function onTrackDragOver(evt) { evt.preventDefault(); evt.dataTransfer.dropEffect = 'copy' }

function onBackgroundClick(event) {
  if (!event || event.target === tracksContentRef.value || event.target.classList.contains('track-row') || event.target.classList.contains('time-block')) {
    store.selectTrack(null)
  }
}

function handleKeyDown(event) {
  const target = event.target
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

  const hasSelection = store.selectedActionId || store.multiSelectedIds.size > 0 || store.selectedCycleBoundaryId || store.selectedSwitchEventId
  if (!hasSelection) return

  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    const result = store.removeCurrentSelection();
    if (result && result.total > 0) {
      ElMessage.success({ message: t('timelineGrid.selection.deleted'), duration: 800 })
    }
  }
  if (store.selectedActionId || store.multiSelectedIds.size > 0) {
    if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') { event.preventDefault(); store.nudgeSelection(-1) }
    if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') { event.preventDefault(); store.nudgeSelection(1) }
  }
}

function handleGlobalKeyUp(e) {
  if (e.key === 'Alt') {
    isAltDown.value = false;
    hideAlignGuide()
  }
  if (e.key === 'Shift') {
    isShiftDown.value = false;
    recalcAlignGuide()
  }
}

function resetModifierKeys() {
  isAltDown.value = false
  isShiftDown.value = false
  hideAlignGuide()
}

function handleGlobalKeyDownWrapper(e) {
  if (e.key === 'Alt') {
    e.preventDefault()
    isAltDown.value = true
    recalcAlignGuide()
  }
  if (e.key === 'Shift') {
    isShiftDown.value = true
    recalcAlignGuide()
  }
  handleKeyDown(e)
}

function updateTrackRects() {
  trackLaneRefs.value.forEach(ref => {
    const idx = ref.dataset.trackIndex
    const rect = ref.getBoundingClientRect()
    const style = window.getComputedStyle(ref)
    let borderTop = parseInt(style.borderTopWidth)
    let borderBottom = parseInt(style.borderBottomWidth)
    if (Number.isNaN(borderTop)) borderTop = 0
    if (Number.isNaN(borderBottom)) borderBottom = 0
      
    const data = {
      top: rect.top + borderTop,
      bottom: rect.bottom - borderBottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height - borderTop - borderBottom
    }
    store.setTrackLaneRect(idx, data)
  })
}

const activeFreezeRegions = computed(() => {
  const selectedIds = store.multiSelectedIds
  const hoveredId = store.hoveredActionId
  if (selectedIds.size === 0 && !hoveredId) return []
  return (store.globalExtensions || []).filter(ext => {
    return ext.sourceId === hoveredId || selectedIds.has(ext.sourceId)
  })
})

watch(() => store.timeBlockWidth, () => { nextTick(() => { forceSvgUpdate(); updateScrollbarHeight() }) })
watch(() => [store.tracks, store.connections], () => { nextTick(() => { forceSvgUpdate() }) }, { deep: true })

onMounted(() => {
  if (tracksContentRef.value) {
    tracksContentRef.value.addEventListener('scroll', syncVerticalScroll)
    const tracksResizeObserver = new ResizeObserver(([entry]) => { 
      updateTrackRects()
      const rect = entry.target.getBoundingClientRect()
      store.setTimelineRect(rect.width, rect.height, rect.top, rect.right, rect.bottom, rect.left)
      forceSvgUpdate(); updateScrollbarHeight();
    })
    tracksResizeObserver.observe(tracksContentRef.value)
    resizeObserver.push(tracksResizeObserver)
    updateScrollbarHeight()
  }
  window.addEventListener('keydown', handleGlobalKeyDownWrapper)
  window.addEventListener('keyup', handleGlobalKeyUp)
  window.addEventListener('blur', resetModifierKeys)
})
onUnmounted(() => {
  if (tracksContentRef.value) tracksContentRef.value.removeEventListener('scroll', syncVerticalScroll);
  resizeObserver.forEach(obs => obs.disconnect())
  resizeObserver = []
  window.removeEventListener('keydown', handleGlobalKeyDownWrapper)
  window.removeEventListener('keyup', handleGlobalKeyUp)
  window.removeEventListener('mousemove', onWindowMouseMove)
  window.removeEventListener('mouseup', onWindowMouseUp)
  window.removeEventListener('mousemove', onBoxMouseMove)
  window.removeEventListener('mouseup', onBoxMouseUp)
  window.removeEventListener('blur', resetModifierKeys)
  window.removeEventListener('mousemove', onPrepResizeMouseMove)
  window.removeEventListener('mouseup', onPrepResizeMouseUp)
})
</script>

<template>
  <div class="timeline-grid-layout" :style="{ gridTemplateRows: `${gridRowHeight} 1fr` }">
    <div class="corner-placeholder">
      <div class="corner-controls">
        <div class="corner-button-row">
          <button class="mini-tool-btn" :class="{ 'is-active': store.showCursorGuide }" @click="store.toggleCursorGuide" :title="t('timelineGrid.toolbar.cursorGuide')">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="6" x2="12" y2="18"></line><line x1="6" y1="12" x2="18" y2="12"></line></svg>
          </button>
          <button class="mini-tool-btn" :class="{ 'is-active': store.isBoxSelectMode }" @click="store.toggleBoxSelectMode" :title="t('timelineGrid.toolbar.boxSelect')">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 4"/><path d="M8 12h8" stroke-width="1.5"/><path d="M12 8v8" stroke-width="1.5"/></svg>
          </button>
          <button class="mini-tool-btn" :class="{ 'is-active': store.snapStep < 0.1 }" @click="store.toggleSnapStep" :title="t('timelineGrid.toolbar.snapPrecision')">
            <span class="btn-text">{{ store.snapStep < 0.05 ? '1f' : '0.1s' }}</span>
          </button>
          <button class="mini-tool-btn" :class="{ 'is-active': store.useNewCompiler }" @click="store.toggleNewCompiler" :title="t('timelineGrid.toolbar.compilerToggle')">
            <span class="btn-text">{{ store.useNewCompiler ? t('common.new') : t('common.old') }}</span>
          </button>
        </div>
        
        <div class="corner-zoom-row">
          <div class="zoom-info-line">
            <span class="zoom-label">SCALE</span>
            <span class="zoom-value">{{ Math.round((store.timeBlockWidth / 50) * 100) }}%</span>
          </div>
          <div class="zoom-slider-container">
            <span class="zoom-icon" @click="adjustZoom(-Math.max(1, Math.round(store.timeBlockWidth * 0.1)), null)"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M19 13H5v-2h14v2z"/></svg></span>
            <input type="range" class="davinci-range" :min="store.ZOOM_LIMITS.MIN" :max="store.ZOOM_LIMITS.MAX" step="1" v-model.number="zoomValue" />
            <span class="zoom-icon" @click="adjustZoom(Math.max(1, Math.round(store.timeBlockWidth * 0.1)), null)"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></span>
          </div>
        </div>
      </div>
    </div>

    <div class="time-ruler-wrapper" ref="timeRulerWrapperRef" @click="store.selectTrack(null)">
      <div class="ruler-content-container" :style="transformStyle">
      <div v-if="store.prepDuration > 0" class="prep-zone-bg prep-zone-bg--ruler" :style="{ width: `${prepZoneWidthPxRounded}px` }"></div>
       <div v-if="store.prepDuration > 0" class="battle-start-line battle-start-line--ruler" :style="{ left: `${prepZoneWidthPxRounded}px` }">
         <div v-if="store.prepExpanded" class="battle-start-handle" @mousedown.stop.prevent="onPrepResizeMouseDown"></div>
       </div>
       <div v-if="store.prepDuration > 0 && store.prepExpanded" class="prep-ruler-controls" :style="{ left: `${prepZoneWidthPxRounded}px` }">
          <button type="button" class="prep-mini-btn" @click.stop="openPrepDurationEditor"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path></svg></button>
       </div>
       <div v-if="store.prepDuration > 0 && !store.prepExpanded" class="prep-zone-controls" :style="{ width: `${prepZoneWidthPxRounded}px`, bottom: showGameTime ? '40px' : '20px' }">
          <button type="button" class="prep-mini-btn" @click.stop="openPrepDurationEditor"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v6l4 2"></path></svg></button>
       </div>

      <div v-if="isPrepDurationEditorOpen" class="prep-duration-popover" :style="{ left: `${prepZoneWidthPxRounded + 8}px` }" @mousedown.stop>
        <input ref="prepDurationInputRef" v-model="prepDurationDraft" class="prep-duration-input" type="number" min="0.5" step="0.1" @keydown.enter.prevent="applyPrepDurationDraft" @keydown.esc.prevent="closePrepDurationEditor" @blur="applyPrepDurationDraft" />
        <span class="prep-duration-unit">s</span>
      </div>

      <div v-if="store.prepDuration > 0" class="prep-rtgt-wrapper" :style="{ width: `${prepZoneWidthPxRounded}px` }">
        <div v-show="showGameTime" class="prep-rtgt-row prep-rtgt-row--game">
           <button type="button" class="timeline-label interactable" @click.stop="isGameTimeCollapsed = true"><text font-weight="bold">G</text></button>
        </div>
        <div class="prep-rtgt-row prep-rtgt-row--real">
          <template v-if="showGameTime"><div class="timeline-label"><text font-weight="bold">R</text></div></template>
          <template v-else><button type="button" class="timeline-label interactable expand-btn" @click.stop="isGameTimeCollapsed = false"><svg viewBox="0 0 24 24" width="16" height="16" stroke-width="3" fill="none"><polyline points="18 15 12 9 6 15"></polyline></svg></button></template>
        </div>
      </div>
      <div v-show="showGameTime" class="time-ruler-track game-time" :style="{ width: `${totalWidthComputed}px` }">
        <div v-for="tick in dynamicTicks.gameTicks" :key="tick.time" class="tick-line" :class="tick.type" :style="{ left: `${Math.round(tick.x)}px` }"><span v-if="tick.label" class="tick-label">{{ tick.label }}</span></div>
      </div>
      <div class="time-ruler-track" :style="{ width: `${totalWidthComputed}px` }">
        <div v-for="tick in dynamicTicks.realTicks" :key="tick.time" class="tick-line" :class="tick.type" :style="{ left: `${Math.round(tick.x)}px` }"><span v-if="tick.label" class="tick-label">{{ tick.label }}</span></div>
      </div>
      <div class="operation-layer">
        <div v-for="op in operationMarkers" :key="op.id" class="key-cap" :class="[op.customClass, { 'is-hold': op.isHold }]" :style="{ left: `${op.left}px`, top: `${op.top}px`, width: op.width ? `${op.width}px` : 'auto', height: `${op.height}px`, fontSize: `${op.fontSize}px` }"><span class="key-text">{{ op.label }}</span></div>
      </div>
      </div>
    </div>

    <div class="tracks-header-sticky" ref="tracksHeaderRef" @click="store.selectTrack(null)" :style="{ paddingBottom: `${20 + scrollbarHeight}px` }">
      <div v-for="(track, index) in store.teamTracksInfo" :key="index" class="track-info" @click.stop="store.selectTrack(track.id)" :class="{ 'is-active': track.id && track.id === store.activeTrackId, 'is-reorder-target': reorderDropTargetIndex === index && draggingTrackOrderIndex !== index, 'is-reorder-source': draggingTrackOrderIndex === index }" @dragover="onReorderDragOver($event, index)" @drop="onReorderDrop($event, index)" @dragend="onReorderDragEnd">
        <div class="track-controls">
           <div class="reorder-btn arrow-btn up-btn" @click.stop="moveTrackUp(index)" :class="{ disabled: index === 0 }"><svg viewBox="0 0 24 24" width="10" height="10" stroke-width="3" fill="none"><polyline points="18 15 12 9 6 15"></polyline></svg></div>
           <div class="drag-handle" draggable="true" @dragstart="onReorderDragStart($event, index)"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="8" cy="4" r="2"></circle><circle cx="8" cy="12" r="2"></circle><circle cx="8" cy="20" r="2"></circle><circle cx="16" cy="4" r="2"></circle><circle cx="16" cy="12" r="2"></circle><circle cx="16" cy="20" r="2"></circle></svg></div>
           <div class="reorder-btn arrow-btn down-btn" @click.stop="moveTrackDown(index)" :class="{ disabled: index === store.tracks.length - 1 }"><svg viewBox="0 0 24 24" width="10" height="10" stroke-width="3" fill="none"><polyline points="6 9 12 15 18 9"></polyline></svg></div>
        </div>
        <div class="char-select-trigger">
          <div class="operator-row">
            <div class="trigger-avatar-box" @click.stop="openCharacterSelector(index)"><img v-if="track.id" :src="track.avatar" class="avatar-image" /><div v-else class="avatar-placeholder"></div></div>
            <div class="trigger-info" @click="!track.id && openCharacterSelector(index)"><span class="trigger-name">{{ track.name || t('timelineGrid.track.selectOperator') }}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="tracks-content-viewport" ref="tracksContentRef" @mousedown="onContentMouseDown" @wheel="handleTrackWheel" @mousemove="onGridMouseMove" @mouseleave="onGridMouseLeave" @contextmenu="onBackgroundContextMenu">
      <div class="tracks-content-scroller" :style="transformStyle">
        <div v-if="store.showCursorGuide && !store.isBoxSelectMode" class="cursor-guide" :style="{ transform: `translateX(${store.cursorPosTimeline.x}px)` }" v-show="isCursorVisible">
          <div class="guide-time-label">{{ store.formatAxisTimeLabel(store.cursorCurrentTime) }}</div>
          <div class="guide-sp-label">SP: {{ currentSpValue }}</div>
          <div class="guide-stagger-label">STAGGER: {{ currentStaggerValue }}</div>
          <div v-if="cursorGaugeRows.length" class="guide-gauge-panel">
            <div class="guide-gauge-grid"><div v-for="row in cursorGaugeRows" :key="row.id" class="guide-gauge-grid-row"><span class="guide-gauge-name" :style="{ color: row.color }">{{ row.name }}</span><span class="guide-gauge-value"><span>{{ row.val }}</span><span>/</span><span>{{ row.max }}</span></span></div></div>
          </div>
        </div>

        <div v-for="boundary in (store.cycleBoundaries || [])" :key="boundary.id" class="cycle-guide" :class="{ 'is-selected': boundary.id === store.selectedCycleBoundaryId }" :style="{ left: `${store.timeToPx(boundary.time)}px` }" @mousedown="onCycleLineMouseDown($event, boundary.id)"><div class="cycle-label-time">{{ store.formatAxisTimeLabel(boundary.time) }}</div><div class="cycle-hit-area"></div></div>

        <div v-if="alignGuide.visible" class="align-guide-layer"><div class="target-highlight-box" :style="{ left: `${alignGuide.targetRect.left}px`, top: `${alignGuide.targetRect.top}px`, width: `${alignGuide.targetRect.width}px`, height: `${alignGuide.targetRect.height}px`, color: alignGuide.color }"></div><div class="guide-line-vertical" :style="{ left: `${alignGuide.x}px`, color: alignGuide.color }"></div></div>

        <div v-if="isBoxSelecting" class="selection-box-overlay" :style="{ left: `${boxRect.left}px`, top: `${boxRect.top}px`, width: `${boxRect.width}px`, height: `${boxRect.height}px` }"></div>

        <div class="tracks-content">
          <div v-if="store.prepDuration > 0" class="prep-zone-bg prep-zone-bg--content" :style="{ width: `${prepZoneWidthPxRounded}px` }"></div>
          <div v-if="store.prepDuration > 0 && !store.prepExpanded" class="prep-collapsed-entry" :style="{ width: `${prepZoneWidthPxRounded}px` }"><button type="button" class="prep-collapsed-toggle" @click.stop="store.togglePrepExpanded"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"><polyline points="8 6 16 12 8 18"></polyline></svg></button></div>
          <div v-if="store.prepDuration > 0 && store.prepExpanded" class="prep-expanded-collapse" :style="{ left: `${Math.max(0, prepZoneWidthPxRounded - 18)}px` }"><button type="button" class="prep-mini-btn" @click.stop="store.togglePrepExpanded"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"><polyline points="16 6 8 12 16 18"></polyline></svg></button></div>
          
          <ContextMenu />

          <div v-for="(track, index) in store.tracks" :key="index" class="track-row" :id="`track-row-${index}`" :style="{ '--track-height': `${TRACK_HEIGHT}px` }" :class="{ 'is-active-drop': track.id === store.activeTrackId,'is-last-track': index === store.tracks.length - 1 }" @dragover="onTrackDragOver" @drop="onTrackDrop(track, $event)">
            <div class="track-lane" :style="getTrackLaneStyle" ref="trackLaneRefs" :data-track-index="index" :data-track-id="track.id">
              <GaugeOverlay v-if="track.id" :track-id="track.id"/>
              <div class="actions-container">
                <ActionItem v-memo="[action]" v-for="action in track.actions" :key="action.instanceId" :action="action" @mousedown="onActionMouseDown($event, track, action)" @mousemove="updateAlignGuide($event, action)" @mouseleave="hideAlignGuide" @contextmenu.prevent.stop="onActionContextMenu($event, action)" :class="{ 'is-moving': isDragStarted && store.isActionSelected(action.instanceId) }" />
              </div>
              <div class="switch-marker-layer">
                <div v-for="sw in (store.switchEvents || []).filter(s => s.characterId === track.id)" :key="sw.id" class="switch-tag" :class="{ 'is-selected': sw.id === store.selectedSwitchEventId, 'is-dragging': sw.id === draggingSwitchEventId }" :style="{ left: `${store.timeToPx(sw.time)}px` }" @mousedown.stop="onSwitchMarkerMouseDown($event, sw.id)"><div class="tag-avatar"><img :src="(store.characterRoster || []).find(c => c.id === sw.characterId)?.avatar" /></div></div>
              </div>
            </div>
          </div>

          <div class="global-freeze-layer">
            <div v-for="(ext, idx) in activeFreezeRegions" :key="idx" class="freeze-region-dim" :style="{ left: `${store.timeToPx(ext.time)}px`, width: `${store.timeToPx(ext.time + ext.amount) - store.timeToPx(ext.time)}px` }"><div class="freeze-duration-label">{{ store.formatTimeLabel(ext.amount) }}</div></div>
          </div>
        </div>
      </div>

      <div class="timeline-horizontal-scrollbar" ref="fakeScrollbarRef" @scroll="onFakeScroll"><div class="scrollbar-spacer" :style="{ width: `${totalWidthComputed}px` }"></div></div>
    </div>

    <el-dialog v-model="isSelectorVisible" :title="t('timelineGrid.operatorDialog.title')" width="600px" align-center class="char-selector-dialog" :append-to-body="true">
      <div class="selector-header">
        <div class="header-left-group">
          <el-input v-model="searchQuery" :placeholder="t('timelineGrid.operatorDialog.searchPlaceholder')" :prefix-icon="Search" clearable style="width: 180px" />
          <button class="ea-btn ea-btn--glass-cut ea-btn--glass-cut-danger" @click="removeOperator">{{ t('common.unequip') }}</button>
        </div>
        <div class="element-filters">
          <button v-for="elm in ELEMENT_FILTERS" :key="elm.value" class="ea-btn ea-btn--glass-cut" :class="{ 'is-active': filterElement === elm.value }" :style="{ '--ea-btn-accent': elm.color }" @click="filterElement = elm.value">{{ elm.label }}</button>
        </div>
      </div>
      <div class="roster-scroll-container">
        <template v-for="group in rosterByRarity" :key="group.level">
          <div class="rarity-header" :style="{ color: getRarityBaseColor(group.level) }"><span class="rarity-label">{{ group.level }} ★</span><div class="rarity-line"></div></div>
          <div class="roster-grid">
            <div v-for="char in group.list" :key="char.id" class="roster-card" :class="[{ 'is-selected': store.tracks.some(t => t.id === char.id) }, `rarity-${char.rarity}-style`]" @click="confirmCharacterSelection(char.id)">
              <div class="card-avatar-wrapper" :style="char.rarity === 6 ? {} : { borderColor: getRarityBaseColor(char.rarity) }"><img :src="char.avatar" loading="lazy" /><div class="element-badge" :style="{ background: store.getColor(char.element) }"></div></div>
              <div class="card-name">{{ char.name }}</div>
            </div>
          </div>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.timeline-grid-layout { display: grid; grid-template-columns: 180px 1fr; grid-template-rows: 60px 1fr; width: 100%; height: 100%; overflow: hidden; user-select: none; }
.corner-placeholder { background: #3a3a3a; border-bottom: 1px solid #444; border-right: 1px solid #444; padding: 8px; }
.mini-tool-btn { height: 20px; background: #2b2b2b; border: 1px solid #555; color: #888; cursor: pointer; border-radius: 3px; }
.mini-tool-btn.is-active { color: #ffd700; border-color: #ffd700; }
.tracks-header-sticky { grid-column: 1 / 2; grid-row: 2 / 3; background: #3a3a3a; border-right: 1px solid #444; overflow: hidden; }
.track-info { min-height: 110px; display: flex; align-items: center; padding-left: 8px; border-bottom: 1px solid #444; transition: background 0.2s; }
.track-info.is-active { background: #4a5a6a; border-right: 3px solid #ffd700; }
.avatar-image { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #555; }
.avatar-placeholder { width: 44px; height: 44px; border-radius: 50%; background: #444; border: 2px dashed #666; }
.tracks-content-viewport { grid-column: 2 / 3; grid-row: 2 / 3; background: #18181c; overflow-y: auto; overflow-x: hidden; position: relative; }
.track-row { min-height: 50px; padding: 30px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
.track-lane { position: relative; height: 50px; background: rgba(255, 255, 255, 0.02); }
.cursor-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: #ffd700; z-index: 50; }
.cycle-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: #d3adff; cursor: col-resize; z-index: 40; }
.freeze-region-dim { position: absolute; top: 0; bottom: 0; background: rgba(0,0,0,0.4); pointer-events: none; }
.roster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 16px; padding: 10px; }
.card-avatar-wrapper { position: relative; width: 72px; height: 72px; background: #111; border: 1px solid #444; padding: 2px; }
.card-avatar-wrapper img { width: 100%; height: 100%; object-fit: cover; }
.rarity-6-style .card-avatar-wrapper { border: 1px solid #ffd700; }
.timeline-horizontal-scrollbar { position: absolute; bottom: 0; left: 0; width: 100%; height: 12px; overflow-x: auto; opacity: 0.6; z-index: 100; }
</style>