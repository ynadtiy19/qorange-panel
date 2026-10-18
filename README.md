# QOrange VPS 控制面板

QOrange 是一个轻量级的单服务器应用部署面板。登录后，可连接多个 GitHub 账号，从所选账号可访问的仓库（包括私有仓库）中选择分支、配置可选端口映射和环境变量，并构建、部署及管理服务。面板支持启动、停止、重启、查看日志、替换环境变量和删除托管容器。

登录后保留“服务器信息”和“项目”两个页面。“服务器信息”展示本机可读取的主机名、系统平台与内核版本、架构、运行时间、CPU 型号/核心数/负载与采样使用率、内存和根目录磁盘用量、本地 IPv4、面板进程状态、Docker daemon 状态与版本，以及带 QOrange 所有权标签的容器和端口。系统数据来自 Node.js OS/filesystem API；Docker 状态使用只读 Docker CLI 查询。首次 CPU 使用率采样会显示“采样中”。云服务商、区域、到期时间、费用、网络配额、延迟以及防火墙状态不会被推测，当前不可检测或未配置的项目会明确标为“未知/未配置”。

## 首次安装

### VPS 准备

目标主机必须是 Linux/systemd VPS，并已安装 Node.js 18+、npm、Docker Engine 且 Docker daemon 正在运行。安装脚本以 root（通常通过 `sudo`）运行；**脚本不会安装 Node.js 或 Docker，也不会自动推测或检查最低 CPU、内存、磁盘规格**。请在安装前自行确认 VPS 有足够的资源、磁盘空间和网络访问能力。不要在运行中的业务数据库尚未备份时，把首次安装或升级当作数据库备份方案。

安装脚本会检查 Linux、root 权限、systemd、所需命令、Node.js 主版本至少为 18、Docker daemon 可用，以及现存安装目录和 systemd unit 是否可安全接管。它会以只读方式列出名称中包含 Mongo 的容器，并只检查 `/data/mongo_data` 是否存在；不会读取该目录内容、停止或更改现有 MongoDB，也不会安装、备份或恢复数据库。

### 安装

在 VPS 上执行：

```sh
curl --fail --show-error --location https://raw.githubusercontent.com/ynadtiy19/qorange-panel/main/install.sh --output /tmp/qorange-panel-install.sh && sudo bash /tmp/qorange-panel-install.sh
```

服务通过本地健康检查后，安装程序会显示面板地址；首次安装还会**仅显示一次**随机管理员密码，请立即保存。用户名为 `admin`。管理员密码的 scrypt 哈希保存在 `/etc/qorange-panel/auth.json`，会话签名密钥保存在 `/etc/qorange-panel/session.key`。重复运行安装程序或进行下文所述的代码升级都不会重新生成或覆盖这些文件，因此不会重置管理员密码。

安装程序下载面板代码、安装生产依赖，并管理 `/opt/qorange-panel`、`/etc/qorange-panel`、`/var/lib/qorange-panel`、`/data/apps/qorange-panel` 和 `/data/apps/env`。它会创建或保留管理员认证文件和会话密钥，写入 systemd unit 并启动面板；本地 `/healthz` 通过后才报告成功。它不会配置 HTTPS、防火墙或 GitHub OAuth Client ID。新安装默认监听所有网络接口的 HTTP 8888 端口；应按“安全访问”配置 HTTPS/SSH 隧道后再使用。

已有的 `/etc/qorange-panel/panel.env` 会被保留；安装程序不会重置 `BIND_ADDRESS`、`COOKIE_SECURE` 或其他已有选项。程序升级不会更改服务注册表、环境变量、构建目录、应用数据或 MongoDB 数据，也不会删除 `/data/apps/*`。现有 MongoDB 容器及 `/data/mongo_data` 不会被更改。

对于可识别的旧版 QOrange 配置，首次迁移会迁移应用服务信息，将环境变量移入权限为 `0600` 的独立文件，丢弃旧版弱 `authSecret`，并忽略数据库服务中的 `runCmd`（不会执行它）。

## 更新已安装的面板

当新版本已合并到 `main` 后，可安排维护窗口更新；安全修复应尽快更新。升级会短暂停止面板，开始前先确认运行中的服务、准备备份，并对重要数据库按其数据库专用流程做一致性备份。默认路径的面板文件可按下列方式备份（若 `panel.env` 指向自定义目录，请先检查并据此调整；备份含管理员认证、OAuth token、环境变量等秘密，必须妥善保护）：

```sh
BACKUP_DIR="/root/qorange-panel-pre-update-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "$BACKUP_DIR"
sudo cp -a /etc/qorange-panel "$BACKUP_DIR/"
sudo cp -a /data/apps/qorange-panel "$BACKUP_DIR/"
sudo cp -a /data/apps/env "$BACKUP_DIR/"
```

再从 VPS 下载并运行更新脚本：

```sh
curl --fail --show-error --location https://raw.githubusercontent.com/ynadtiy19/qorange-panel/main/update.sh --output /tmp/qorange-panel-update.sh && sudo bash /tmp/qorange-panel-update.sh
```

更新脚本要求 root、systemd、Node.js 18+、现存且正在运行的面板服务、面板管理标记、认证/会话文件和 `panel.env` 均有效；它还检查配置的端口和绑定地址。脚本下载 `main` 中的代码并运行 `npm ci`，但**不会安装 Node.js/Docker、检查 Docker daemon、检查 VPS 最低规格、验证应用容器或数据库健康，也不会备份或迁移 MongoDB 数据**。更新会短暂停止面板服务；只有本机 `/healthz` 检查通过才报告成功。更新失败时会自动恢复旧程序文件并尝试重启；成功后旧程序副本保留在 `/opt/qorange-panel.rollback.<UTC 时间>`。

更新**不会**调用首次安装程序，也不会更改 `/etc/qorange-panel/auth.json`、`session.key`、`panel.env`、服务注册表、GitHub account store、环境变量文件或 MongoDB 数据。更新后检查服务状态、日志和本机健康端点：

```sh
sudo systemctl status qorange-panel --no-pager
sudo journalctl -u qorange-panel -n 80 --no-pager
curl --fail --show-error http://127.0.0.1:8888/healthz
```

如果健康检查失败且自动恢复未完成，可手动恢复**程序代码**：停止服务，将当前 `/opt/qorange-panel` 改名为明确的故障副本，再将目标 `/opt/qorange-panel.rollback.<UTC 时间>` 改回 `/opt/qorange-panel`，然后启动服务并重复健康检查。使用实际目录名，不要用通配符。回滚目录只包含程序文件，不是数据库或面板状态备份；不要删除或覆盖 `/etc/qorange-panel`、`/data/apps` 中的数据。若更新引入持久化格式变化，代码回滚本身不一定能回滚数据，因此更新前仍需独立备份。

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

然后在本机打开 `http://127.0.0.1:8888`。面板的管理 API 使用签名、HttpOnly、SameSite 会话 Cookie、同源校验和 CSRF 令牌。GitHub 账号通过 OAuth Device Flow 连接；访问令牌只保存在面板服务器，不会发送到浏览器，也不要将 GitHub Token 粘贴到面板中。

**访问面板必须使用 HTTPS 或 SSH 隧道；不要通过公网 HTTP 使用面板。** 管理员可以在环境变量页面按需显示或导出原始密钥，因此应只在可信设备和可信网络上操作，并避免将秘密复制到不可信的剪贴板或应用中。

## 配置 GitHub 账号连接

在 GitHub Developer Settings 中创建 OAuth App，并启用 **Device Flow**。Device Flow 不需要 OAuth client secret；将该 OAuth App 的 **Client ID** 配置在 VPS 的 `/etc/qorange-panel/panel.env` 中：

```sh
sudoedit /etc/qorange-panel/panel.env
```

添加 `GITHUB_CLIENT_ID=<OAuth App Client ID>`（请填写 GitHub 提供的 Client ID，不要配置 client secret），保存后重启面板：

```sh
sudo systemctl restart qorange-panel
sudo systemctl status qorange-panel --no-pager
```

登录面板后打开“GitHub 账号”，选择“连接 GitHub 账号”，在 GitHub 显示的验证页面输入设备代码并授权。可连接多个账号；导入仓库时要明确选择访问账号，服务会保存该账号关联，后续私有仓库分支查询和归档下载都使用同一账号。断开账号会清除其本地访问令牌；服务仍保留账号关联以避免静默切换，重新连接同一 GitHub 登录名会恢复原关联。

面板请求 `repo` OAuth scope，以便访问所选账号有权读取的私有仓库。GitHub OAuth App 没有仅限私有仓库只读的细粒度 scope；`repo` 的授权权限也涵盖对仓库的更广泛操作能力，虽然 QOrange 面板只调用读取仓库、分支和归档的 API。只连接可信账号，并按需在 GitHub 撤销授权。访问令牌存放在面板 `DATA_DIR/github-accounts.json`，目录权限为 `0700`、文件权限为 `0600`；unlink 会从存储文件中移除令牌。公开仓库仍可在没有已连接账号时以 `owner/repository` 方式导入，且不会使用全局 GitHub CLI 登录状态。

## 环境变量和部署

每行输入一个 `KEY=VALUE`。环境变量存放在 `/data/apps/env/<service-id>.env`，文件权限受限；服务列表只显示是否已配置及变量数量。环境变量页面默认只显示名称和固定掩码；管理员可通过单变量“显示原值”按需查看，也可显式打开“编辑原始环境变量”读取完整的 `KEY=VALUE` 文本，或确认后复制全部变量。原始编辑不会自动保存，必须手动点击保存；关闭编辑窗口或退出登录会清除界面中的明文。单独添加、更新或删除变量的功能仍可使用。原值读取和导出仅由已登录管理员通过受同源和 CSRF 保护的请求触发；这些响应禁止缓存。已知环境变量值会从容器日志和操作错误中隐藏。

服务注册信息及部署尝试结果会保存在服务注册表中；刷新后服务不会消失。面板将当前 Docker 容器状态与最近部署结果分开判断，不会把没有容器的已保存服务误报为已部署；部署中、失败、中断、容器缺失和上次成功部署时间均会明确显示。不要重复导入列表中的服务，使用该服务的“构建并部署”按钮重试。分支列表和归档下载通过所选账号的 GitHub API 获取；归档下载有超时和大小上限。Docker 操作只管理带有 QOrange 所有权标签的容器，并使用 `docker container inspect` 明确检查容器对象，不会将同名镜像误判为容器。删除服务时，如果其托管容器已不存在，也会清理服务注册信息和私有环境变量文件；如果同名容器不是 QOrange 所有，普通删除会先拒绝并提示确认。确认后可选择只移除 QOrange 服务注册信息和私有环境变量文件；此请求必须显式声明保留非托管容器，且不会停止或删除该容器。容器仍会运行，移除记录后需要另行手动管理。保存环境变量会随服务记录一并清除。普通“删除”仅会停止并删除已验证带有匹配 QOrange 所有权标签的容器。删除不会删除镜像、构建源文件或 MongoDB 数据。没有未认证的 Webhook；部署只能从已登录的面板发起。

## GitHub 仓库导入与部署

导入时选择一个已连接账号及其可访问仓库，或在没有连接账号时输入公开仓库 `owner/repository`；随后从 GitHub 返回的分支列表中搜索并选择分支。服务会保存该账号、仓库和分支，部署时使用同一账号获取该分支归档。当前构建实现要求归档根目录包含 `Dockerfile`，并使用 `docker build` 构建镜像；它不会执行 `docker-compose`，也不会依据 `package.json`、Python/Go 清单推测启动方式。应用仓库若没有根目录 `Dockerfile`，部署不会成功。Dockerfile 指令会在 Docker build 环境中运行，导入前应审查仓库来源和构建内容。

服务端会校验仓库和分支格式，并在保存服务时确认所选分支确实存在；部署归档下载具有大小限制和超时。Docker 操作只管理带有 QOrange 所有权标签的容器。删除服务不会删除镜像、构建源文件或数据库数据。

## MongoDB 边界、连接与持久化

**当前版本没有 MongoDB 管理界面或生命周期 API**：不会创建/删除 MongoDB、选择或修改现有容器、创建 Docker network/volume，也不会自动把数据库 URI 注入所有应用。代码中的 Mongo URI helper 不代表已实现数据库服务功能；旧版迁移会忽略数据库服务记录和 `runCmd`，不会执行其中的命令。安装程序只读列出现存 Mongo 容器名称，并检查 `/data/mongo_data` 是否存在；安装、更新和面板部署都不会触碰该目录或任何 MongoDB 数据。

### 绑定现有数据库

先由数据库负责人确认实例、备份责任、网络地址、认证数据库、TLS 要求和应用所需的环境变量名。现有 MongoDB 容器/数据目录均按**只读、不可接管**处理；不要为了让面板应用连接而停止、重建、迁移容器，改挂载点，或把数据库端口暴露到公网。面板部署的应用容器使用 Docker 默认网络，当前没有将应用容器接入用户自定义 MongoDB 网络的功能。因此，只有当数据库已有一个从应用容器可达且经批准的地址时，才可以在该应用的“环境变量”中配置应用实际读取的连接串（例如 `MONGODB_URI`）；该值会保存在受限环境变量文件中。URI 中的用户名/密码应按 URI 规则编码，并使用数据库提供的私网 DNS/IP、TLS 和最小权限账号。保存后重新构建并部署应用。

如果现有数据库只在 VPS 的某个 Docker 私有网络中，或仅监听宿主机 loopback，而当前应用容器无法访问，**不要通过公网开放端口或猜测容器 IP 来绕过限制**。当前没有安全的面板内“绑定现有 MongoDB”步骤；先保持数据库不变，待显式的 Docker network 连接功能实现，或使用已批准且从应用容器可达的数据库端点。

### 新数据库与应用连接

面板当前也不能创建或管理新的 MongoDB 实例，因此没有可由面板完成的“新建并绑定”向导。不要把现有 `/data/mongo_data` 当作新实例目录，也不要手动将其挂载到另一个容器。若运营方决定在面板之外建立全新实例，应先确认新实例需求和恢复负责人，再使用**独立且唯一**的专用 Docker volume/数据目录、私有网络、认证、限制访问的防火墙规则和 TLS；除非经过单独风险评估，不发布 MongoDB 主机端口。应用只有在面板支持把它接入该私有网络、或存在其他经批准的可达端点后，才能在应用环境变量中配置该新实例 URI。不要将“手动创建”描述为由 QOrange 托管。

MongoDB 持久化和备份目前均由运营方负责；Docker volume 不等同于备份。使用 MongoDB 原生一致性备份/恢复流程（例如 `mongodump`/`mongorestore`，并按部署规模与一致性需求选项配置），将备份加密后存放在独立介质或异地位置，定期在隔离目标上演练恢复。不要在数据库运行期间直接复制其数据目录来代替一致性备份；恢复前先确认目标为空或明确批准覆盖、校验恢复内容，再安排应用切换。**永远不要用面板安装/更新、容器重建或恢复操作覆盖现有 `/data/mongo_data`。**

## 开发和检查

```sh
npm install
npm test
npm run check
bash -n install.sh update.sh
```

`/healthz` 是最小化的未认证健康检查端点。服务、GitHub 和系统管理 API 均要求先登录。
