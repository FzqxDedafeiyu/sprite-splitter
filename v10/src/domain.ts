export type UUID = string;
export type SpriteLayer = "background" | "midground" | "foreground";
export type SpriteShape = "rectangle" | "polygon";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResourceVersion {
  resourceId: UUID;                  // 逻辑资源身份；替换字节时保持不变
  revision: number;                  // 从 1 开始单调递增；资源字节变化时递增
  contentHash: string;               // sha256:<64 lowercase hex>，对完整资源字节计算
  byteLength: number;                // 实际资源字节数
}

export interface SourceImage {
  id: UUID;
  revision: number;
  filename: string;
  width: number;
  height: number;
  availability: "available" | "missing";
  assetRef?: string;                 // 仅 available 时存在；相对项目包根目录
  resourceVersion?: ResourceVersion; // available 时必须存在；与原图字节对应
  legacyExtensions?: Record<string, unknown>;
}

export interface RasterRef extends ResourceVersion {
  kind: "mask";
  assetRef: string;                  // 项目包内资源路径，相对项目包根目录
  coordinateSpace: "spriteLocal";  // 当前 Sprite PNG 左上角为 (0,0)
  width: number;                     // 必须等于对应 Sprite PNG 的实际宽度
  height: number;                    // 必须等于对应 Sprite PNG 的实际高度
  encoding: "bitmap" | "rle";      // 字节布局由带版本的编码协议定义
}

export interface AgentAnnotation {
  tags: string[];
  confidence?: number;               // 仅来源明确提供时写入，范围 0..1
  reviewStatus?: string;             // 保留来源原值，不擅自归一未知枚举
  sourceAgent?: string;
  updatedAt?: string;
  legacyExtensions?: Record<string, unknown>;
}

export interface SpriteAsset {
  id: UUID;                         // V10 稳定 UUID，唯一身份
  legacyId?: string;                // 例如 V9 sprite_001，仅用于兼容追溯
  legacyIndex?: number;              // V9 1-based index，仅供显示 / 诊断
  name: string;
  category: string;
  description?: string;
  groupName?: string | null;          // 旧版素材分组元数据，不等同于 SceneGroup
  sourceImageId?: UUID;              // 关联原始整图；缺失原图时仍可保留来源元数据
  assetRef: string;                  // 裁切 Sprite PNG，相对项目包根目录
  rasterResource: ResourceVersion;   // Sprite PNG 的逻辑资源版本；assetRef 指向该版本字节
  sourceRect?: Rect;                 // source-image 像素坐标；未知时省略
  sourceRectStatus: "known" | "unknown";
  shape: SpriteShape;
  points?: Point[];                  // spriteLocal；rectangle 可省略
  mask?: RasterRef;                  // 用户可编辑 Mask；原始 PNG Alpha 不存入此字段
  agentAnnotation?: AgentAnnotation;
  contentVersion: number;            // 像素 / Alpha / mask / 几何缓存版本
  revision: number;                  // 本实体业务数据版本
  legacyAnchor?: Point;              // 原样保留的 V9 source-image 全局坐标
  legacyExtensions?: Record<string, unknown>;
}

export interface SceneTransform {
  scaleX: number;
  scaleY: number;
  rotation: number;                  // 角度单位固定为 degree；围绕 Sprite 中心
}

export interface SpriteRelations {
  nearTo: UUID[];
  attachedTo: UUID[];
  supports: UUID[];
}

export interface SceneLayout {
  spriteId: UUID;                    // 与 SpriteAsset.id 对应
  layer: SpriteLayer;
  depth: number;
  parallax: number;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  position: Point;                   // Sprite 未缩放、未旋转时的左上角 sceneWorld 坐标；唯一绘制定位基准
  transform: SceneTransform;         // 仅 scale / rotation；围绕 Sprite 中心
  sceneAnchor: Point;                // sceneWorld 参考标记，不决定绘制原点
  anchorSource: "explicit" | "defaulted" | "legacy-unknown";
  relations: SpriteRelations;        // 所有引用均为 V10 UUID
  revision: number;
}

export interface SceneWorld {
  coordinateOrigin: "top-left";
  units: "source-pixels";
  width?: number;
  height?: number;
}

export interface SceneLayoutDocument {
  revision: number;                  // world / mode / items 成员关系变化时递增
  mode?: string;                     // V9 layoutMode 等兼容语义
  world: SceneWorld;
  items: Record<UUID, SceneLayout>;  // key 必须等于 item.spriteId
}

export interface SceneGroup {
  id: UUID;
  name: string;
  memberSpriteIds: UUID[];
  revision: number;
}

export interface ProjectSettings {
  revision: number;
  colorSpace: "srgb";
  pixelArt: {
    enabled: boolean;
    renderSnap: "round" | "floor" | "none";
  };
  defaultFps: number;                 // 新项目默认 12 FPS
  autosaveEnabled: boolean;
  extensions?: Record<string, unknown>;
}

export type LegacyIdMapping =
  | { status: "mapped"; legacyId: string; spriteId: UUID; legacyIndex?: number; sourceFile?: string }
  | { status: "missing_asset"; legacyId: string; legacyIndex?: number; sourceFile?: string }
  | { status: "ambiguous"; legacyId: string; legacyIndex?: number; sourceFile?: string; candidateFiles?: string[] };

export interface MigrationMetadata {
  sourceFormat: string[];
  sourceProjectVersion?: number;
  migratedAt: string;
  adapterVersion: string;
  idMap: LegacyIdMapping[];
  warnings: MigrationWarning[];
}

export interface MigrationWarning {
  code: string;
  severity: "info" | "warning" | "error";
  legacyId?: string;
  path?: string;
  message: string;
  resolution?: string;
}

export interface RevisionLedger {
  entities: Record<string, number>; // entityType:id -> 最新版本；删除后保留 tombstone 水位
  resources: Record<string, number>; // resourceId -> 最新版本；资源字节 GC 后仍保留 ID 水位
}

export interface ProjectDocument {
  kind: "sprite-project";
  projectSchemaVersion: 10;
  projectId: UUID;
  sourceImages: SourceImage[];
  assets: SpriteAsset[];             // 唯一权威 Sprite 集合
  sceneGroups: SceneGroup[];
  sceneLayout: SceneLayoutDocument;
  animationSets: AnimationSet[];
  animationClips: AnimationClip[];
  pivotPresets: PivotPreset[];
  projectSettings: ProjectSettings;
  migrationMetadata?: MigrationMetadata;
  legacyExtensions?: Record<string, unknown>;
  revision: number;                  // 项目级单调递增版本
  revisionLedger: RevisionLedger;     // live revision 与 ledger 对应；已删除 ID 不得复用
}

export type AssetType = "character" | "object";

export type PivotPresetType =
  | "foot" | "body" | "action" | "center"
  | "bottom" | "hinge" | "custom";

export type CalibrationSource =
  | "default"
  | "geometry_auto"
  | "manual"
  | "ai_suggested"
  | "accepted_ai"
  | "imported";

export type CalibrationMode = "preview" | "apply";

export interface AnimationSet {
  id: string;
  revision: number; // Set 自身名称、类型、成员变化时递增
  name: string;
  assetType: AssetType;
  spriteIds: string[];
  // clipIds 是派生索引，不持久化；通过 AnimationClip.setId 查询。
  createdAt: string;
  updatedAt: string;
}

export interface AnimationClip {
  id: string;
  revision: number; // Clip 任一持久化字段变化时递增
  setId: string; // 所属 Set 的权威外键
  name: string;
  actionType: string;
  fps: number;
  loop: boolean;
  canvas: { width: number; height: number }; // clipCanvas 像素尺寸
  pivotPresetId: string;
  pivotTarget: Point; // clipCanvas
  frames: AnimationFrame[];
  metadata?: Record<string, unknown>;
}

export interface AnimationFrame {
  id: string;
  revision: number; // 本 Frame 任一持久化字段变化时递增
  spriteId: string;
  duration: number; // 帧时长倍率；播放秒数 = duration / fps
  alignment: {
    pivotLocal: Point; // spriteLocal
    offset: Point; // clipCanvas 平移向量
    pivotSource: CalibrationSource;
    offsetSource: CalibrationSource;
    confidence?: number;
    locked?: boolean;
    algorithmVersion?: string;
    calibratedAt?: string;
    algorithmParameters?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface PivotPreset {
  id: string;
  revision: number; // 预设定义变化时递增
  name: string;
  assetType: AssetType | "both";
  actionTypes: string[];
  strategy:
    | "bbox_center"
    | "alpha_centroid"
    | "bottom_center"
    | "bottom_contact"
    | "semantic_point"
    | "custom";
  normalizedPoint?: Point;
  description?: string;
}
