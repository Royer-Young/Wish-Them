# 06 第 4 轮开发总结・每日任务与打卡模块

> 范围：
>
> `GET /api/wishes/:id/tasks/today`
>
> 、
>
> `POST /api/tasks/:id/checkin`
>
> 、
>
> `POST /api/tasks/:id/makeup`
>
> ，以及惰性日界、周补卡券与配套测试 / 文档。
> 结论：代码、冒烟与静态校验全绿；
>
> **云端第一阶段（真库迁移 /seed/ 验证）仍未完成**
>
> ，原因见 §4。

## 1. 实现范围

### 1.1 接口（3 条，累计 15 条）



| 接口                                | 关键行为                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/wishes/:id/tasks/today` | 只回当天任务；04:00 产品日；访问时把此前 `pending` 惰性标 `missed`；非作者 403；不返回总天数 / 剩余天数；附带本周补卡券                                        |
| `POST /api/tasks/:id/checkin`     | 必填 `proof_id`、可选 `note≤30`；提交即 `done`；`server_ts` 服务器时间；重复提交 200 + `already_done` 并原地覆盖证明 / 备注；支持 `Idempotency-Key` |
| `POST /api/tasks/:id/makeup`      | 仅 `missed` 且仅当前自然周；每周一张券；`made_up` + `is_makeup:true`；券不足 / 过期 / 跨周各自明确错误码；同样支持 `Idempotency-Key`                   |

### 1.2 代码落点



| 文件                                                                                                                                         | 职责                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [backend/domain/checkin.ts](../backend/domain/checkin.ts)                          | 打卡 / 补卡全部业务逻辑：证明文件校验、任务作者校验、打卡覆盖、补卡券发放 / 消费 / 放回、DTO                         |
| [backend/domain/task.ts](../backend/domain/task.ts)                                | `findTask`、`sweepMissedTasks`、`listTasksByDate`；`toTaskDto` 增加 `is_optional` |
| [backend/domain/wish.ts](../backend/domain/wish.ts)                                | 立契后发放首周补卡券并在响应返回 `makeup_ticket`                                             |
| [backend/api/wishes/\_id/tasks/today.ts](../backend/api/wishes/_id/tasks/today.ts) | 今日页路由：扫描、批量取打卡、确保本周券                                                         |
| [backend/api/tasks/\_id/checkin.ts](../backend/api/tasks/_id/checkin.ts)           | 打卡路由与参数校验                                                                    |
| [backend/api/tasks/\_id/makeup.ts](../backend/api/tasks/_id/makeup.ts)             | 补卡路由与参数校验                                                                    |
| [backend/api/manifest.ts](../backend/api/manifest.ts)                              | 注册 3 条新路由（15 条）                                                              |
| [backend/lib/quota.ts](../backend/lib/quota.ts)                                    | 新增滚动分钟窗 `minuteWindow`                                                       |
| [backend/lib/config.ts](../backend/lib/config.ts)                                  | 新增 `CHECKIN_PER_MINUTE`（默认 10，1–600）                                         |
| [tools/local/smoke.ts](../tools/local/smoke.ts)                                    | 第 11 节：58 项新断言（累计 203）                                                       |

### 1.3 一致性与边界



* **日界**：`productDate` / `weekStartOf` 固定 Asia/Shanghai；无 cron，今日页、打卡、补卡三个入口各自执行一次条件批量更新 `pending AND task_date < today → missed`。

* **打卡**：`pending→done` 单行 CAS；`UNIQUE (task_id)` + `insertIfAbsent`→`update` 保证一任务一行；重复提交覆盖证明与备注。

* **补卡**：先校验任务 `missed` 且属于当前周，再校验证明，最后烧券（`available→used` CAS）并改任务；任务 CAS 失败时把券放回并回 409。

* **周券**：`UNIQUE (wish_id, week_start)`；签约发首周券；之后惰性补发；`expires_at` 过期由读路径标 `expired`。

* **版本**：任务 / 打卡写操作给 `wishes.version + 1`（读 - 改 - CAS，3 次），供第 5 轮结算。

* **幂等**：两个写接口 `idempotent: optional`，同键重放字节级一致；不带键时靠唯一约束与状态机收敛。

## 2. 与 PRD / 本轮需求书的偏差



| 项         | 需求 / 设计                         | 本轮落地                                            | 原因                                                                           |
| --------- | ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| 图片上传      | PRD C-03 要求两段式 presign→complete | **未实现**；打卡只校验已存在的 `files` 行                     | 本轮功能清单未列上传接口；冒烟直接 seed `files` 替身。客户端当前无法通过 API 获得可用的 `proof_id`，这是上线前必须补的缺口 |
| 图片内容      | —                               | 不做内容审核、不做 AI 验收                                 | 用户明确简化口径：提交即完成                                                               |
| 打卡幂等      | 防重复提交                           | 重复提交不算失败：200 + `already_done` + 覆盖              | 需求明确要求「给出提示，允许覆盖更新备注和图片」                                                     |
| 补卡范围      | 每周一张券、仅 missed                  | 额外限制「只能补当前自然周」                                  | 券按周发放，跨周补卡会让「过期作废」失去意义；`makeup_window_closed` 明确告知                           |
| 今日页权限     | 仅作者，非作者 403                     | 读接口也用 403（未沿用读路径 404 的惯例）                       | 本轮需求显式要求 403                                                                 |
| 今日页字段     | 不返回总天数 / 剩余天数                   | 只回 `date/tasks/makeup_ticket`；任务含 `is_optional` | 按需求                                                                          |
| 打卡限流      | 未在功能清单中                         | 新增 `CHECKIN_PER_MINUTE`（默认 10 / 分钟）             | 与既有 `enforceWindow` 体系统一；阈值走环境变量                                             |
| 限流计数口径    | —                               | 按窗口内 `checkins` 行数计，同一任务重复提交不增加计数               | 覆盖写不产生新行；真正需要防的是跨任务刷写。代价是单任务狂点不会被限流，但也不会产生额外行                                |
| 离线 / 撤销   | PRD C-06/E2E-02                 | 未实现离线同步与撤销打卡                                    | 不在本轮清单；`client_ts` 恒 `null`、`revoked_at` 恒 `null`                            |
| 任务列表 / 详情 | PRD 有回看需求                       | 未实现                                             | 不在本轮清单；今日页只回当天                                                               |

## 3. 注意事项（上线 / 联调时）



1. **云端状态未闭环**：第一阶段要求的真库迁移、seed 导入与第三轮成果验证仍被阻塞（`prepare_site` 曾被拒绝；seed 导入需要部署后的 Function 作为写客户端）。本地绿灯不等于线上绿灯。

2. **必须实测的三项平台语义**：`insertIfAbsent` 是否逐行跳过冲突、`affected()` 是否回传真实行数、表级 `UNIQUE` 是否允许多个 `NULL`（`tasks.template_id`）。打卡覆盖与补卡补偿都依赖前两项。

3. **今日页是写接口**：每次 GET 可能写 `tasks`（sweep）与 `makeup_tickets`（发券）。幂等重试安全，但监控上不要把它当纯读。

4. **日界扫描按愿签**：只扫当前 `wish_id` 的过期任务，不是全库清理；用户长期不访问时任务会停留在 `pending`，下次访问才变 `missed`。结算轮读取时必须先跑同口径 sweep，否则会漏算。

5. **时区固定**：`Asia/Shanghai`、04:00 边界、周一换周；不要用 `Intl` 或宿主时区。跨年 / 夏令时不影响（无 DST）。

6. **补卡券顺序**：券先烧、任务后改；只有任务 CAS 失败且券仍指向该任务时才放回。若进程崩在两者之间，券会停在 `used` 且任务仍 `missed`，需要人工 / 补偿脚本核对（本轮无后台）。

7. `proof_id`**&#x20;语义**：服务端只认 `files` 行，不认对象 key；`sha256` 从 `files` 复制到 `checkins`。上传接口补齐前，联调需先手工造 `files` 行。

8. **幂等键**：打卡 / 补卡为可选。不带键时，重复打卡是「覆盖」语义、重复补卡是 `already_made_up`；带键时第二次请求直接重放首次响应，不会再次覆盖。

9. **今日页不返回历史**：前端「第 N 天」需自行用 `task_date` 与 `start_date` 计算；服务端刻意不回总天数，避免与结算口径分叉。

## 4. 验证结果



| 检查                                                      | 结果                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `node tools/local/smoke.ts`                             | **203 passed / 0 failed**（新增 58 项：权限、参数、覆盖、幂等、日界、跨周、券过期、限流） |
| `node tools/scripts/check-routes.ts`                    | 15 条路由自洽                                                    |
| `node tools/scripts/check-schema-usage.ts`              | 21 张表 / 337 列；3 处静态跳过均为已解释的表达式写法                            |
| `node tools/scripts/check-migrations.ts`                | 6 文件 / 94 语句 / 21 表，全部在平台子集内                                |
| `npx -p typescript@5.6.3 tsc -p .tscheck/tsconfig.json` | 无输出（strict 通过）                                              |
| 真库验证                                                    | **未执行**（见 §3.1）                                             |