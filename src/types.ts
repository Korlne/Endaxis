export type ZzzRank = 'S' | 'A';

export type ZzzElement = 'Physical' | 'Fire' | 'Ice' | 'Electric' | 'Ether';

export type ZzzCharacteristic = 'Attack' | 'Break' | 'Anomaly' | 'Support' | 'Defense';

export interface CancelWindows {
    combo?: number;
    dodge?: number;
    skill?: number;
    swap?: number;
}

export interface ZzzAction {
    action_id: string;
    name: string;
    action_type: string;
    start_tick: number;
    duration_ticks: number;
    hit_ticks: number[];
    cancel_windows: CancelWindows;
}

export interface ZzzCharacter {
    id: string;
    name: string;
    rank: ZzzRank;
    element: ZzzElement;
    characteristic: ZzzCharacteristic;
    actions: ZzzAction[];
}

export interface ZzzTimelineMetadata {
    version: string;
    base_fps: number;
    max_ticks: number;
}

export interface ZzzTimelineExport {
    metadata: ZzzTimelineMetadata;
    action_timeline: ZzzAction[];
}