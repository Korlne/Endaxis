export interface ZZZCancelWindows {
  combo?: number; // 连段/普攻取消的偏移帧数
  dodge?: number; // 闪避取消的偏移帧数
  skill?: number; // 技能取消的偏移帧数
  swap?: number; // 切换角色取消的偏移帧数
}

export interface ZZZActionNode {
  id: string; // 节点的唯一标识符
  character_id: string; // 执行当前动作的角色ID
  action_id: string; // 执行的具体动作ID
  start_tick: number; // 动作在时间轴上的起始逻辑帧
  duration_ticks: number; // 动作的持续总逻辑帧数
  hit_ticks: number[]; // 动作触发命中判定的逻辑帧数组
  cancel_windows: ZZZCancelWindows; // 当前动作对应的各类取消窗口触发时间参数
}

export interface ZZZProject {
  name: string; // 方案名称
  version: string; // 外部系统兼容版本规范
  nodes: ZZZActionNode[]; // 该方案下所有动作节点的集合
}