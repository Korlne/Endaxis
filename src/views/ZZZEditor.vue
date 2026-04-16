<script setup>
import { onMounted } from 'vue'
import { useZzzTimelineStore } from '../stores/zzzTimelineStore.js'
import ZZZTimelineGrid from '../components/ZZZTimelineGrid.vue'

const zzzStore = useZzzTimelineStore()

onMounted(() => {
  // 初始化加载逻辑占位
})
</script>

<template>
  <div class="zzz-editor-container">
    <header class="editor-header">
      <h2>ZZZAxis 编辑器</h2>
    </header>

    <div class="editor-main-layout">
      <aside class="layout-left">
        <div class="panel-title">动作库</div>
      </aside>

      <main class="layout-center">
        <div class="timeline-wrapper">
          <ZZZTimelineGrid />
        </div>
      </main>

      <aside class="layout-right">
        <div class="panel-title">属性面板</div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.zzz-editor-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background-color: #18181c;
  color: #f0f0f0;
}

.editor-header {
  height: 48px;
  border-bottom: 1px solid #333;
  display: flex;
  align-items: center;
  padding: 0 16px;
}

.editor-main-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.layout-left, .layout-right {
  width: 300px;
  background-color: #1e1e1e;
  padding: 16px;
}

.layout-left {
  border-right: 1px solid #333;
}

.layout-right {
  border-left: 1px solid #333;
}

.layout-center {
  flex: 1;
  position: relative;
  background-color: #16161a;
  display: flex;
  flex-direction: column;
}

.timeline-wrapper {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.placeholder-grid {
  color: #666;
  font-family: monospace;
}

.panel-title {
  font-size: 14px;
  font-weight: bold;
  color: #888;
  margin-bottom: 16px;
}
</style>