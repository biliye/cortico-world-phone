# 给隧道装一把密钥

**为什么不能只用密码**:隧道得开机就在、断了自己起,而密码登录每次都要人敲 ——
`ssh` 在没有终端时会挂在那儿等输入,表现成"看起来在跑、其实连不上",那是最难查的一种坏。

**为什么不让 World 自己装**:World 只负责**用**这把钥匙;装钥匙是部署者那一步的事。

## 前提:那台机器当时是什么样

这一轮遇到的机器是 **`PermitRootLogin yes` + `PasswordAuthentication yes`,
而 `/root/.ssh/authorized_keys` 是空的(0 字节)** —— 一把公钥都没有。所以第一次必须有个入口
把公钥送进去。**你的机器可能不一样**:先在那台上 `ls -l /root/.ssh/` 看一眼,
已经有钥匙的话直接追加就行,别覆盖。**不管怎样都别向用户要密码走这条路。**

**没有向开发者要密码。** 走的是云厂商那套**已经认证过**的命令通道
(这一轮用的是阿里云的 workbench CLI;换成任意"能在那台上执行一条命令"的通道都等价)。
下面 `<实例 id>` / `<那台的地址>` / `<公钥文件>` 都要换成你自己的:

```bash
# 1) 本机生成一把专门给隧道用的钥匙(不设密码:无人值守要它免交互)
ssh-keygen -t ed25519 -N '' -C 'phone-tunnel' -f <某个不进 git 的路径>/phone-tunnel-key

# 2) 用云通道把公钥追加到那台的 authorized_keys
$WB upload --instance-id <实例 id> \
    --source <某个不进 git 的路径>/phone-tunnel-key.pub --target /root/.tmp-tunnel-key.pub
$WB exec  --instance-id <实例 id> \
    --command 'mkdir -p /root/.ssh && chmod 700 /root/.ssh && cat /root/.tmp-tunnel-key.pub >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && rm -f /root/.tmp-tunnel-key.pub && wc -l /root/.ssh/authorized_keys'
# ★ 追加(>>)不是覆盖(=):那台上可能已经有别人的钥匙。

# 3) 本机验一次:能免密登上去就算成
ssh -i <私钥路径> -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    root@<那台的地址> 'echo TUNNEL_KEY_OK && uname -n'
```

**这把钥匙存哪儿**:代码仓库之外的某个路径(这一轮放在工作区的 `state/tools/` 下,
而 `state/tools/` **不在任何包里**)。铁规矩是:**私钥绝不出现在 `state/packages/` 下面的包里**,
也绝不进 git。`worlds.phone.ssh.keyFile` 就填它的路径 —— 顺便,`cloud/local.env` 里的
`PHONE_KEY` 也可以在手工跑 `tunnel.sh` 时填同一个路径。

## 回滚

把那一行删掉即可,别的什么都不用动。注意删的是**你那一把**(按生成时写进注释的那个备注认):

```bash
$WB exec --instance-id <实例 id> \
    --command 'grep -v phone-tunnel /root/.ssh/authorized_keys > /root/.ssh/ak && mv /root/.ssh/ak /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && wc -l /root/.ssh/authorized_keys'
```

再想干净一点也可以直接清空整个文件(`: > /root/.ssh/authorized_keys`)——
**前提是确认没有别的钥匙在用**。

## 顺带一条建议

这类机器常常是**开着密码登录的 root**。隧道改用密钥之后,可以考虑把
`PasswordAuthentication` 关掉(`/etc/ssh/sshd_config` 改成 `no` 再 `systemctl reload ssh`)
—— 但这是另一个决定,要开发者自己点头,部署脚本不替他动。
