{
  description = "WorkHours — tiny self-hosted time tracker (Node, no deps)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;
    in {
      # The app, packaged as plain files run by node.
      packages = forAll (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in {
          workhours = pkgs.stdenv.mkDerivation {
            pname = "workhours";
            version = "1.0.0";
            src = ./.;
            dontBuild = true;
            installPhase = ''
              mkdir -p $out/share/workhours
              cp -r server.js public $out/share/workhours/
            '';
          };
          default = self.packages.${system}.workhours;
        });

      # NixOS module: import this and set services.workhours.enable = true;
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.workhours;
          app = self.packages.${pkgs.stdenv.hostPlatform.system}.workhours;
        in {
          options.services.workhours = {
            enable = lib.mkEnableOption "WorkHours time tracker";
            port = lib.mkOption { type = lib.types.port; default = 8080; description = "TCP port to listen on."; };
            address = lib.mkOption { type = lib.types.str; default = "0.0.0.0"; description = "Bind address."; };
            openFirewall = lib.mkOption { type = lib.types.bool; default = false; description = "Open the port in the firewall."; };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.workhours = {
              description = "WorkHours time tracker";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];
              environment = {
                PORT = toString cfg.port;
                ADDRESS = cfg.address;
                DATA_DIR = "/var/lib/workhours";
              };
              serviceConfig = {
                ExecStart = "${pkgs.nodejs}/bin/node ${app}/share/workhours/server.js";
                DynamicUser = true;
                StateDirectory = "workhours";        # creates/owns /var/lib/workhours
                Restart = "on-failure";
                RestartSec = 2;
              };
            };

            networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

            # Nightly backup of the JSON db; keeps the newest ~14 copies.
            systemd.services.workhours-backup = {
              description = "Backup WorkHours database";
              serviceConfig.Type = "oneshot";
              script = ''
                set -eu
                src="/var/lib/workhours/db.json"
                dir="/var/lib/workhours/backups"
                ${pkgs.coreutils}/bin/mkdir -p "$dir"
                if [ -f "$src" ]; then
                  ${pkgs.coreutils}/bin/cp "$src" "$dir/db-$(${pkgs.coreutils}/bin/date +%Y%m%d-%H%M%S).json"
                  ls -1t "$dir"/db-*.json | tail -n +15 | xargs -r rm -f
                fi
              '';
            };
            systemd.timers.workhours-backup = {
              wantedBy = [ "timers.target" ];
              timerConfig = { OnCalendar = "daily"; Persistent = true; };
            };
          };
        };
    };
}
