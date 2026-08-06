/** 全局数据模型 */

/** 大纲项(由文档标题生成) */
export interface OutlineItem {
  level: number;
  text: string;
  /** 在 ProseMirror doc 中的位置,用于跳转 */
  pos: number;
}

/** 编辑器统计信息 */
export interface DocStats {
  chars: number;
  words: number;
  lines: number;
}

/** 一个标签页 */
export interface Tab {
  /** 唯一 id */
  id: string;
  /** 显示名(通常是文件名,无扩展名显示标题) */
  title: string;
  /** 磁盘路径;未保存的新文档为 null */
  path: string | null;
  /** 是否为新建未保存文档 */
  isNew: boolean;
  /** 是否有未保存改动 */
  dirty: boolean;
  /** 外部文件的修改时间(毫秒),用于检测外部变更 */
  externalMtime: number;
  /** 编辑器初始内容(仅挂载时使用) */
  initialContent: string;
  /** 最近一次保存成功时的内容(dirty 判定基线,保存后更新) */
  savedContent: string;
  /** 最近一次 markdown 内容镜像(用于源码模式、保存) */
  markdown: string;
  /** 统计信息 */
  stats: DocStats;
}

/** 最近打开记录 */
export interface RecentFile {
  path: string;
  name: string;
  /** 时间戳(毫秒) */
  time: number;
}

/** 主题模式 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 编辑器更新回调负载 */
export interface EditorUpdate {
  markdown: string;
  outline: OutlineItem[];
  stats: DocStats;
  /** 是否有可撤销/重做的历史 */
  canUndo: boolean;
  canRedo: boolean;
}
