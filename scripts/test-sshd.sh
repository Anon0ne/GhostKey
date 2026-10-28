#!/usr/bin/env bash
# Starts a throwaway OpenSSH server on 127.0.0.1:2222 for the live tests and
# prints the GHOSTKEY_TEST_* variables to use. Needs root (CI runners have it).
set -euo pipefail

dir="${1:-$(mktemp -d)}"
mkdir -p "$dir" /run/sshd

id gktest >/dev/null 2>&1 || useradd -m -s /bin/bash gktest
echo 'gktest:Gh0stPass!' | chpasswd

ssh-keygen -q -t ed25519 -N '' -f "$dir/hostkey" <<<y >/dev/null
ssh-keygen -q -t ed25519 -N 'keypass' -f "$dir/userkey" <<<y >/dev/null
install -d -m 700 -o gktest -g gktest /home/gktest/.ssh
install -m 600 -o gktest -g gktest "$dir/userkey.pub" /home/gktest/.ssh/authorized_keys

printf '# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/test123\n' >"$dir/banner"

cat >"$dir/sshd_config" <<CONF
Port 2222
ListenAddress 127.0.0.1
HostKey $dir/hostkey
PidFile $dir/sshd.pid
PasswordAuthentication yes
KbdInteractiveAuthentication yes
PubkeyAuthentication yes
UsePAM yes
Subsystem sftp internal-sftp
Banner $dir/banner
CONF

/usr/sbin/sshd -f "$dir/sshd_config" -E "$dir/sshd.log"

cat <<VARS
GHOSTKEY_TEST_HOST=127.0.0.1
GHOSTKEY_TEST_PORT=2222
GHOSTKEY_TEST_USER=gktest
GHOSTKEY_TEST_PASSWORD=Gh0stPass!
GHOSTKEY_TEST_KEY=$dir/userkey
GHOSTKEY_TEST_KEY_PASSPHRASE=keypass
VARS
