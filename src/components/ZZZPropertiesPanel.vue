<template>
  <div class="zzz-properties-panel">
    <div class="panel-header">
      <h3>动作属性编辑</h3>
    </div>
    
    <div v-if="action" class="panel-content">
      <div class="form-group">
        <label>动作名称</label>
        <input 
          type="text" 
          :value="action.name" 
          @change="updateField('name', ($event.target as HTMLInputElement).value)" 
        />
      </div>

      <div class="form-group">
        <label>角色标签</label>
        <input 
          type="text" 
          :value="action.characterName" 
          @change="updateField('characterName', ($event.target as HTMLInputElement).value)" 
        />
      </div>

      <div class="form-group">
        <label>起始时间 (Tick)</label>
        <input 
          type="number" 
          min="0"
          :value="action.startTime" 
          @change="updateField('startTime', parseInt(($event.target as HTMLInputElement).value) || 0)" 
        />
      </div>

      <div class="form-group">
        <label>持续时长 (Tick)</label>
        <input 
          type="number" 
          min="1"
          :value="action.duration" 
          @change="updateField('duration', Math.max(1, parseInt(($event.target as HTMLInputElement).value) || 1))" 
        />
      </div>

      <div class="form-group hit-ticks-section">
        <label>伤害判定点 (Hit Ticks 偏移)</label>
        <ul class="hit-ticks-list">
          <li v-for="(tick, index) in action.hitTicks" :key="index">
            <span>Offset: {{ tick }}</span>
            <button class="delete-btn" @click="removeHitTick(index)">删除</button>
          </li>
        </ul>
        <div class="add-tick-row">
          <input 
            type="number" 
            v-model.number="newTickOffset" 
            placeholder="输入偏移 Tick" 
            min="0"
          />
          <button class="add-btn" @click="addHitTick">添加</button>
        </div>
      </div>
    </div>
    
    <div v-else class="no-selection">
      请在轨道上选中一个动作块以编辑其属性
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { ZZZAction } from '@/simulation_zzz/types';

const props = defineProps<{
  action: ZZZAction | null;
}>();

const emit = defineEmits(['updateActionData']);

const newTickOffset = ref<number | ''>('');

// 通用字段更新发射器
const updateField = (field: keyof ZZZAction, value: any) => {
  if (!props.action) return;
  emit('updateActionData', { id: props.action.id, field, value });
};

// 判定点管理：删除
const removeHitTick = (index: number) => {
  if (!props.action) return;
  const updatedTicks = [...props.action.hitTicks];
  updatedTicks.splice(index, 1);
  emit('updateActionData', { id: props.action.id, field: 'hitTicks', value: updatedTicks });
};

// 判定点管理：增加
const addHitTick = () => {
  if (!props.action || typeof newTickOffset.value !== 'number') return;
  // 添加并保持升序排列
  const updatedTicks = [...props.action.hitTicks, newTickOffset.value].sort((a, b) => a - b);
  emit('updateActionData', { id: props.action.id, field: 'hitTicks', value: updatedTicks });
  newTickOffset.value = '';
};
</script>

<style scoped>
.zzz-properties-panel {
  width: 300px;
  background-color: #252526;
  border-left: 1px solid #3c3c3c;
  color: #cccccc;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-header {
  padding: 12px 16px;
  background-color: #2d2d2d;
  border-bottom: 1px solid #3c3c3c;
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.panel-content {
  padding: 16px;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
}

.form-group label {
  font-size: 12px;
  margin-bottom: 6px;
  color: #999;
}

.form-group input {
  background-color: #3c3c3c;
  border: 1px solid #555;
  color: #fff;
  padding: 6px 8px;
  border-radius: 4px;
  outline: none;
}

.form-group input:focus {
  border-color: #007acc;
}

.hit-ticks-section {
  border-top: 1px solid #3c3c3c;
  padding-top: 16px;
}

.hit-ticks-list {
  list-style: none;
  padding: 0;
  margin: 0 0 10px 0;
}

.hit-ticks-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background-color: #333;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: 4px;
  font-size: 12px;
}

.delete-btn {
  background: #a12a2a;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  padding: 2px 6px;
}

.add-tick-row {
  display: flex;
  gap: 8px;
}

.add-tick-row input {
  flex: 1;
  width: 0;
}

.add-btn {
  background: #0e639c;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  padding: 0 12px;
}

.no-selection {
  padding: 32px 16px;
  text-align: center;
  color: #666;
  font-size: 13px;
}
</style>