# QOrange VPS 控制面板

QOrange 是一个轻量级的单服务器应用部署面板。登录后，可从已认证的 GitHub CLI 账户中选择仓库（包括私有仓库）、选择分支、配置可选端口映射和环境变量，并构建、部署及管理服务。面板支持启动、停止、重启、查看日志、替换环境变量和删除托管容器。

登录后的“服务器信息”页面展示本机可读取的主机名、系统平台与内核版本、架构、运行时间、CPU 型号/核心数/负载与采样使用率、内存和根目录磁盘用量、本地 IPv4、面板进程状态、Docker daemon 状态与版本，以及带 QOrange 所有权标签的容器和端口。系统数据来自 Node.js OS/filesystem API；Docker 状态使用只读 Docker CLI 查询。首次 CPU 使用率采样会显示“采样中”。云服务商、区域、到期时间、费用、网络配额、延迟以及防火墙状态不会被推测，当前不可检测或未配置的项目会明确标为“未知/未配置”。SSH、升级、防火墙、协作者等目前未实现的页面会标注“暂未支持”。

## 首次安装

适用于已安装并运行 systemd、Node.js 18+、Docker Engine 和 GitHub CLI（`gh`）的 Linux VPS。先以运行安装命令的用户完成 GitHub CLI 登录（`gh auth login`），然后在 VPS 上执行：

```sh
curl --fail --show-error --location https://raw.githubusercontent.com/ynadtiy19/qorange-panel/main/install.sh --output /tmp/qorange-panel-install.sh && sudo bash /tmp/qorange-panel-install.sh
```

服务通过本地健康检查后，安装程序会显示面板地址；首次安装还会**仅显示一次**随机管理员密码，请立即保存。用户名为 `admin`。管理员密码的 scrypt 哈希保存在 `/etc/qorange-panel/auth.json`，会话签名密钥保存在 `/etc/qorange-panel/session.key`。重复运行安装程序或进行下文所述的代码升级都不会重新生成或覆盖这些文件，因此不会重置管理员密码。

安装程序管理 `/opt/qorange-panel`、`/etc/qorange-panel`、`/var/lib/qorange-panel`、`/data/apps/qorange-panel` 和 `/data/apps/env`。已有的 `/etc/qorange-panel/panel.env` 会被保留；安装程序只会在缺少 `HOME`、`GH_CONFIG_DIR` 或 `GH_CLI_PATH` 时补上相应配置，不会重置 `BIND_ADDRESS`、`COOKIE_SECURE` 或其他已有选项。程序升级不会更改服务注册表、环境变量、构建目录、应用数据或 MongoDB 数据，也不会删除 `/data/apps/*`。现有 MongoDB 容器及 `/data/mongo_data` 不会被更改。

对于可识别的旧版 QOrange 配置，首次迁移会迁移应用服务信息，将环境变量移入权限为 `0600` 的独立文件，丢弃旧版弱 `authSecret`，并忽略数据库服务中的 `runCmd`（不会执行它）。

## 更新已安装的面板

合并到 `main` 后，在 VPS 上运行以下命令即可更新面板代码和生产依赖：

```sh
curl --fail --show-error --location https://raw.githubusercontent.com/ynadtiy19/qorange-panel/main/update.sh --output /tmp/qorange-panel-update.sh && sudo bash /tmp/qorange-panel-update.sh
```

升级程序会先下载代码并安装依赖，再停止服务、备份 `/opt/qorange-panel` 中的现有程序文件、安装新版本并启动服务。只有本地 `/healthz` 检查通过才报告成功；下载、依赖安装或健康检查失败时会恢复原程序文件并重新启动服务。成功后，升级前的程序副本保留在 `/opt/qorange-panel.rollback.<UTC 时间>`，可用于手动恢复。升级**不会**调用首次安装程序，也不会更改 `/etc/qorange-panel/auth.json`、`session.key`、`panel.env`、服务数据、环境变量文件或 MongoDB 数据。

升级完成后可检查服务状态及日志：

```sh
sudo systemctl status qorange-panel --no-pager
sudo journalctl -u qorange-panel -n 80 --no-pager
```

如果需要手动恢复，请先停止服务，将当前 `/opt/qorange-panel` 改名作为故障版本，再将对应的 `qorange-panel.rollback.<UTC 时间>` 改回 `/opt/qorange-panel`，然后运行 `sudo systemctl start qorange-panel`。不要删除或覆盖 `/etc/qorange-panel` 或 `/data/apps` 中的数据。

## 安全访问

安装默认监听所有网络接口，并使用 HTTP。**不要在未配置 HTTPS 时把 8888 端口开放到公网**。推荐先通过防火墙禁止公网访问 8888，然后将 `BIND_ADDRESS` 设置为 `127.0.0.1`，配置 HTTPS 反向代理到 `127.0.0.1:8888`，再将 `COOKIE_SECURE` 设置为 `1` 并重启服务：

```sh
sudoedit /etc/qorange-panel/panel.env
sudo systemctl restart qorange-panel
```

临时远程访问可使用 SSH 隧道：

```sh
ssh -L 8888:127.0.0.1:8888 <your-vps>
```

然后在本机打开 `http://127.0.0.1:8888`。面板的管理 API 使用签名、HttpOnly、SameSite 会话 Cookie、同源校验和 CSRF 令牌。GitHub 凭据从已登录的 `gh` 配置读取；不要将 GitHub Token 粘贴到面板中。

**访问面板必须使用 HTTPS 或 SSH 隧道；不要通过公网 HTTP 使用面板。** 管理员可以在环境变量页面按需显示或导出原始密钥，因此应只在可信设备和可信网络上操作，并避免将秘密复制到不可信的剪贴板或应用中。

## 环境变量和部署

每行输入一个 `KEY=VALUE`。环境变量存放在 `/data/apps/env/<service-id>.env`，文件权限受限；服务列表只显示是否已配置及变量数量。环境变量页面默认只显示名称和固定掩码；管理员可通过单变量“显示原值”按需查看，也可显式打开“编辑原始环境变量”读取完整的 `KEY=VALUE` 文本，或确认后复制全部变量。原始编辑不会自动保存，必须手动点击保存；关闭编辑窗口或退出登录会清除界面中的明文。单独添加、更新或删除变量的功能仍可使用。原值读取和导出仅由已登录管理员通过受同源和 CSRF 保护的请求触发；这些响应禁止缓存。已知环境变量值会从容器日志和操作错误中隐藏。

服务注册信息及部署尝试结果会保存在服务注册表中；刷新后服务不会消失。面板将当前 Docker 容器状态与最近部署结果分开判断，不会把没有容器的已保存服务误报为已部署；部署中、失败、中断、容器缺失和上次成功部署时间均会明确显示。不要重复导入列表中的服务，使用该服务的“构建并部署”按钮重试。部署通过 `gh api` 下载 GitHub 分支归档，私有仓库使用现有 GitHub CLI 登录。Docker 操作只管理带有 QOrange 所有权标签的容器。删除服务会移除其托管容器和环境变量文件，但不会删除镜像、构建源文件或 MongoDB 数据。没有未认证的 Webhook；部署只能从已登录的面板发起。

## GitHub 仓库导入与部署方案

在导入仓库时，QOrange 会优先检查分支中的 `Dockerfile`，随后是 `docker-compose.yml` / `compose.yaml` 以及常见应用清单（`package.json`、`requirements.txt` / `pyproject.toml`、`go.mod`）。检测到的方案只用于生成“构建与运行”的安全预览，并要求在实际部署前确认；任何推断命令都不会被静默执行，也不会在宿主机上直接执行仓库代码。

- 优先级是：`Dockerfile` > `docker-compose`/`compose` > 常见语言清单；这是确定性顺序，避免不同脚本在不同分支中混用。
- 预览只接受受控配置，不会隐藏地触发 `bash -c`、主机网络挂载、`volumes`、`pid: host`、`privileged` 与其他高风险 Compose 功能；遇到不受支持或危险特性会显式返回错误，而不是执行修改宿主机状态的操作。
- 端口和默认环境变量可在确认步骤中编辑；如果仓库没有可识别的方案，部署会拒绝，而不是猜测一个可能破坏环境的启动命令。

## MongoDB 服务与持久化

QOrange 只支持显式管理的 MongoDB 方案：

- 现有 MongoDB 绑定必须由用户在确认后手动选择，不会被静默写入到所有应用环境变量中。
- 现有 MongoDB 容器和 `/data/mongo_data` 均视为受保护资源，不会被停止、重建、覆盖或迁移。
- 新建 MongoDB 服务使用唯一服务 ID、随机强认证、官方稳定镜像和专用命名卷或受控目录，且默认保持端口未公开，服务通过 Docker 私有网络使用稳定 DNS 解析。
- 若用户确实要求对外暴露 MongoDB 端口，必须单独确认，并接受端口分配和防火墙风险提示。
- 备份和迁移应作为手动运营流程处理；当前版本不会自动导入、覆盖或重写已有数据库。

## 更新与运维

在 VPS 上更新已安装的面板时，使用：

```sh
sudo /opt/qorange-panel/update.sh
```

更新脚本会保留 `/etc/qorange-panel` 中的认证与会话配置、`/data/apps/env` 中的私有环境变量文件、服务注册表和所有现有应用数据；它不会删除 QOrange 自己管理的容器或已存在的 MongoDB 数据目录。执行更新前请先确认运行中的服务不会依赖已被强制重建的状态，并在需要时预先记录或备份关键数据。

## 开发和检查

```sh
npm install
npm test
npm run check
bash -n install.sh update.sh
```

`/healthz` 是最小化的未认证健康检查端点。服务、GitHub 和系统管理 API 均要求先登录。
