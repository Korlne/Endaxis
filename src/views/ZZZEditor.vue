<template>
  <div class="ea-app-container zzz-axis-theme">
    <header class="ea-header">
      <div class="header-left">
        <div class="ea-logo">
          <img src="/logo.webp" alt="Logo" class="logo-img" width="24" height="24" />
          <span class="logo-text">ZZZaxis <small>极简排轴器</small></span>
        </div>
        <div class="divider-vertical"></div>
        <nav class="header-nav">
          <button class="ea-btn ea-btn--sm ea-btn--outline" @click="goBack">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            返回 Endfield
          </button>
        </nav>
      </div>

      <div class="header-center">
        <div class="project-info">
          <span class="mode-badge">可视化预览模式</span>
        </div>
      </div>

      <div class="header-right">
        <button class="ea-btn ea-btn--sm ea-btn--lift ea-btn--primary" @click="addAction">
          + 添加新动作
        </button>
        <div class="divider-vertical"></div>
        <button class="ea-btn ea-btn--sm ea-btn--lift ea-btn--info" @click="handleExport">
          导出 JSON
        </button>
      </div>
    </header>

    <main class="ea-main-layout">
      <aside class="ea-sidebar sidebar-left">
        <div class="sidebar-header">
          <span class="title">动作库预设</span>
        </div>
        <div class="sidebar-content">
          <div 
            v-for="tmpl in presets" 
            :key="tmpl.name" 
            class="zzz-library-item"
            @click="addPreset(tmpl)"
          >
            <div class="item-color-tag" :style="{ backgroundColor: getCharacterColor(tmpl.characterName) }"></div>
            <div class="item-details">
              <div class="name">{{ tmpl.name }}</div>
              <div class="char">{{ tmpl.characterName }}</div>
            </div>
          </div>
        </div>
      </aside>

      <section class="ea-workspace">
        <div class="canvas-container">
          <ZZZTimelineCanvas
            :actions="actions"
            :zoom="zoom"
            @updateActionData="updateActionData"
            @select="selectedActionId = $event"
          />
        </div>
        
        <div class="ea-status-bar">
          <div class="zoom-control">
            <span class="label">缩放:</span>
            <input type="range" v-model.number="zoom" min="0.5" max="10" step="0.5" />
            <span class="value">{{ zoom.toFixed(1) }}x</span>
          </div>
          <div class="divider-vertical"></div>
          <div class="timeline-info">
            总时长: {{ totalDuration }} Ticks ({{ (totalDuration/60).toFixed(2) }}s)
          </div>
        </div>
      </section>

      <aside class="ea-sidebar sidebar-right">
        <ZZZPropertiesPanel
          :action="selectedAction"
          @updateActionData="updateActionData"
        />
      </aside>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import ZZZTimelineCanvas from '@/components/ZZZTimelineCanvas.vue';
import ZZZPropertiesPanel from '@/components/ZZZPropertiesPanel.vue';
import { exportZZZData } from '@/api/zzzFileStrategy.js';
import type { ZZZAction } from '@/simulation_zzz/types';

const router = useRouter();

// 数据状态
const actions = ref<ZZZAction[]>([
  { id: 'init-1', name: '连携技-极速', characterName: '安比', duration: 45, hitTicks: [30], startTime: 0 }
]);
const zoom = ref(3);
const selectedActionId = ref<string | null>(null);

// 动作库预设
const presets = [
  { name: '普通攻击-1', characterName: '安比', duration: 25, hitTicks: [12] },
  { name: '分支：落雷', characterName: '安比', duration: 60, hitTicks: [40, 50] },
  { name: '闪避反击', characterName: '妮可', duration: 40, hitTicks: [20] },
  { name: '终结技', characterName: '比利', duration: 120, hitTicks: [30, 60, 90] },
];

const selectedAction = computed(() => {
  return actions.value.find(a => a.id === selectedActionId.value) || null;
});

const totalDuration = computed(() => {
  if (actions.value.length === 0) return 0;
  return Math.max(...actions.value.map(a => a.startTime + a.duration));
});

const getCharacterColor = (name: string) => {
  const colors: Record<string, string> = {
    '安比': '#8bc34a', '妮可': '#e91e63', '比利': '#f44336'
  };
  return colors[name] || '#607d8b';
};

const goBack = () => router.push('/timeline');

const addAction = () => {
  const newId = crypto.randomUUID();
  actions.value.push({
    id: newId,
    name: '空动作',
    characterName: '未知',
    duration: 60,
    hitTicks: [],
    startTime: totalDuration.value
  });
  selectedActionId.value = newId;
};

const addPreset = (p: any) => {
  const newId = crypto.randomUUID();
  actions.value.push({ ...p, id: newId, startTime: totalDuration.value });
  selectedActionId.value = newId;
};

const updateActionData = (data: { id: string, field: keyof ZZZAction, value: any }) => {
  const target = actions.value.find(a => a.id === data.id);
  if (target) (target as any)[data.field] = data.value;
};

const handleExport = () => {
  const data = exportZZZData({ actions: actions.value });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `zzz_timeline_${Date.now()}.json`;
  link.click();
};
</script>

<style scoped>
/* 局部样式补充，主样式复用 src/styles/ui.css */
.zzz-app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background-color: #121212;
}

.ea-header {
  height: 54px;
  background: #1a1a1b;
  border-bottom: 1px solid #333;
  display: flex;
  align-items: center;
  padding: 0 16px;
  justify-content: space-between;
}

.header-left, .header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ea-logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo-text {
  font-weight: bold;
  color: #ffd700; /* ZZZ 标志性的黄色 */
}

.ea-main-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.ea-sidebar {
  width: 260px;
  background: #1e1e1f;
  border-right: 1px solid #333;
  display: flex;
  flex-direction: column;
}

.sidebar-right {
  border-right: none;
  border-left: 1px solid #333;
  width: 300px;
}

.sidebar-header {
  padding: 12px;
  font-size: 12px;
  text-transform: uppercase;
  color: #888;
  border-bottom: 1px solid #2d2d2d;
}

.zzz-library-item {
  display: flex;
  padding: 10px;
  gap: 10px;
  cursor: pointer;
  border-bottom: 1px solid #2d2d2d;
  transition: background 0.2s;
}

.zzz-library-item:hover {
  background: #2a2a2b;
}

.item-color-tag {
  width: 4px;
  border-radius: 2px;
}

.item-name {
  font-size: 13px;
  color: #eee;
}

.item-char {
  font-size: 11px;
  color: #666;
}

.ea-workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #141415;
  position: relative;
}

.canvas-container {
  flex: 1;
  overflow: auto;
  padding: 40px 20px;
}

.ea-status-bar {
  height: 32px;
  background: #1a1a1b;
  border-top: 1px solid #333;
  display: flex;
  align-items: center;
  padding: 0 16px;
  font-size: 12px;
  color: #999;
  gap: 16px;
}

.mode-badge {
  background: rgba(255, 215, 0, 0.1);
  color: #ffd700;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}
</style>