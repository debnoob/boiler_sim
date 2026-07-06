import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Allow other PCs on the same WiFi to load the dev dashboard.
  // Add each accessing machine's LAN IP here; the wildcard covers the subnet.
  allowedDevOrigins: ['192.168.0.155', '192.168.0.*', '192.168.1.*'],
};

export default nextConfig;
