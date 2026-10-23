import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/ui', use: { baseURL: 'https://g2-client.test', browserName: 'chromium', viewport: { width: 390, height: 844 }, launchOptions: process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {} }, reporter: 'list' });
