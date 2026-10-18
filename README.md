# QOrange VPS 控制面板

QOrange 是一个轻量级的单服务器应用部署面板。登录后，可从已认证的 GitHub CLI 账户中选择仓库（包括私有仓库）、选择分支、配置可选端口映射和环境变量，并构建、部署及管理服务。面板支持启动、停止、重启、查看日志、替换环境变量和删除托管容器。

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

## 环境变量和部署

每行输入一个 `KEY=VALUE`。环境变量存放在 `/data/apps/env/<service-id>.env`，文件权限受限；面板不会在服务列表或 API 中返回这些值。面板不会读取并回显已保存的值；替换时需输入完整的新变量集合。已知环境变量值会从容器日志和操作错误中隐藏。

部署通过 `gh api` 下载 GitHub 分支归档，私有仓库使用现有 GitHub CLI 登录。Docker 操作只管理带有 QOrange 所有权标签的容器。删除服务会移除其托管容器和环境变量文件，但不会删除镜像、构建源文件或 MongoDB 数据。没有未认证的 Webhook；部署只能从已登录的面板发起。

## 开发和检查

```sh
npm install
npm test
npm run check
bash -n install.sh update.sh
```

`/healthz` 是最小化的未认证健康检查端点。服务、GitHub 和系统管理 API 均要求先登录。
