#!/bin/bash
set -e

# Block LAN access (RFC1918 + link-local)
iptables -A OUTPUT -d 10.0.0.0/8 -j DROP
iptables -A OUTPUT -d 172.16.0.0/12 -j DROP
iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
iptables -A OUTPUT -d 169.254.0.0/16 -j DROP

# Disable IPv6 LAN access
sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null || true

# Bootstrap Nix if /nix volume is mounted but not installed
if [ -d /nix ] && [ ! -f /nix/.installed ]; then
    NIX_VERSION="2.28.3"
    if curl -L "https://releases.nixos.org/nix/nix-${NIX_VERSION}/install" | sh -s -- --no-daemon; then
        touch /nix/.installed
    else
        echo "WARNING: Nix installation failed" >&2
    fi
fi
[ -f /root/.nix-profile/etc/profile.d/nix.sh ] && . /root/.nix-profile/etc/profile.d/nix.sh

# Drop NET_ADMIN so the app can't undo iptables rules
exec setpriv --no-new-privs --bounding-set=-net_admin,-net_raw -- "$@"
