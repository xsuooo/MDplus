# Glossary

MDPlus 的领域词汇。一个概念只用一个词；「避免」列出的是不要再用的同义词。

| 术语              | 含义                                                                                                                                     | 避免                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| workspace         | 内存里的全部标签及其运行时状态（当前标签、编辑器实例、内容镜像、计数器）                                                                 | session（用于此义）                                           |
| session           | 落盘的「上次打开的文稿列表」及其位置，用于下次启动时恢复                                                                                 |                                                               |
| recovery snapshot | 未保存内容的落盘副本，崩溃或保存失败后可恢复                                                                                             | draft、journal、protect、clean                                |
| content version   | 每次内容变化加一的计数器，用来判断异步步骤期间有没有新编辑                                                                               | generation（用于此义）                                        |
| disk revision     | 文稿在磁盘上的字节版本。外部变更以它判定                                                                                                 |                                                               |
| disk mtime        | 上次已知的磁盘修改时间                                                                                                                   | external mtime                                                |
| autosave paused   | 磁盘与本地冲突或读写失败后，自动保存停止，等用户手动保存                                                                                 | blocked                                                       |
| image token       | 尚未写入文稿目录的图片在文档里的标识，以 `mdplus-image:` 开头                                                                            | placeholder（仍是 `UrlRewrite` 的字段名，尚未改）、identity   |
| stash key         | 原生进程内图片暂存区的随机键                                                                                                             | key（单独使用）                                               |
| disk url          | 图片写入 Markdown 的相对路径                                                                                                             | relativePath（仍是 `UrlRewrite` 的字段名，尚未改）、reference |
| preview url       | WebView 用来显示图片的地址                                                                                                               | source                                                        |
| url rewrite       | 一对 `{ from, to }`（目标名称，代码尚未改；`UrlRewrite` 现为 `{ placeholder, relativePath }`），把正文里的图片地址从一种形式改写成另一种 | PendingImageReference                                         |
| place             | 内存里的光标与滚动位置，仅当前进程有效                                                                                                   |                                                               |
| session place     | 落盘的位置，用文本锚点表示，跨进程有效                                                                                                   |                                                               |
| text anchor       | 偏移加前后各 40 个字符的上下文，文本变化后仍能重新定位                                                                                   |                                                               |
| mode exchange     | 一次模式切换缓存的「源码位置与富文本位置」对，切回时原样复用                                                                             |                                                               |
| position lease    | 异步操作期间持续跟踪的位置，随文档编辑自动映射，用完必须释放                                                                             |                                                               |
