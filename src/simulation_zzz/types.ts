// ZZZ 模式动作单元：仅包含名称、时长和判定点
export interface ZZZAction {
  id: string;            // 唯一标识
  name: string;          // 动作名称 (如: 普通攻击第1段, 强化特殊技)
  characterName: string; // 所属角色名称 (用于视觉区分)
  duration: number;      // 动作总时长 (单位: Ticks 或 秒)
  hitTicks: number[];    // 伤害判定点相对于动作起始点的偏移量
  startTime: number;     // 在全局时间轴上的起始位置
}

// ZZZ 全局排轴数据
export interface ZZZTimelineData {
  version: "1.0.0";      // 版本号
  actions: ZZZAction[];  // 单轨道动作序列
  baseFps: 60;           // ZZZ 默认基于 60 帧进行计算
}