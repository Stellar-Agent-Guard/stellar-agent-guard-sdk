#!/usr/bin/env pwsh
# Verify CI fixes and push

Write-Host "=== Verifying CI Fixes ===" -ForegroundColor Cyan

Set-Location "C:\Users\akachia\Desktop\DRIPS\stellar-agent-guard-sdk"

# Step 1: Verify files exist
Write-Host "`n[1/5] Checking fixture files..." -ForegroundColor Yellow
$fixtures = @(
    "tests/unit/replay.test.ts",
    "tests/fixtures/rpc/replay-admissible.json",
    "tests/fixtures/rpc/replay-blocked-per-tx-cap.json",
    "tests/fixtures/rpc/replay-blocked-recipient-not-allowed.json",
    "tests/fixtures/rpc/replay-blocked-window-cap.json",
    "tests/fixtures/rpc/replay-blocked-paused.json",
    "tests/fixtures/rpc/replay-undetermined-malformed.json"
)

$allExist = $true
foreach ($file in $fixtures) {
    if (Test-Path $file) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ MISSING: $file" -ForegroundColor Red
        $allExist = $false
    }
}

if (-not $allExist) {
    Write-Host "`nERROR: Some files are missing!" -ForegroundColor Red
    exit 1
}

# Step 2: Type check
Write-Host "`n[2/5] Running type check..." -ForegroundColor Yellow
npm run typecheck
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Type check failed!" -ForegroundColor Red
    Write-Host "Fix the TypeScript errors above and try again." -ForegroundColor Yellow
    exit 1
}
Write-Host "  ✓ Type check passed" -ForegroundColor Green

# Step 3: Lint
Write-Host "`n[3/5] Running lint..." -ForegroundColor Yellow
npm run lint
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Lint failed!" -ForegroundColor Red
    Write-Host "Try running: npm run lint -- --fix" -ForegroundColor Yellow
    exit 1
}
Write-Host "  ✓ Lint passed" -ForegroundColor Green

# Step 4: Test
Write-Host "`n[4/5] Running replay tests..." -ForegroundColor Yellow
npm test -- tests/unit/replay.test.ts
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Tests failed!" -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Tests passed" -ForegroundColor Green

# Step 5: Commit and push
Write-Host "`n[5/5] Ready to commit and push" -ForegroundColor Yellow
Write-Host ""
Write-Host "All checks passed! ✅" -ForegroundColor Green
Write-Host ""

$response = Read-Host "Do you want to commit and push now? (y/n)"
if ($response -eq 'y') {
    Write-Host "`nCommitting changes..." -ForegroundColor Cyan
    git add tests/unit/replay.test.ts
    git commit -m "fix: correct GuardEvent property access and add undefined to optional type

- Use event.decision.result instead of event.status
- Use event.decision.reason instead of event.reason  
- Add undefined to reason optional type for exactOptionalPropertyTypes
- Add null checks for event and event.decision"
    
    Write-Host "`nPushing to GitHub..." -ForegroundColor Cyan
    git push origin feat(test)/fixture-driven-live-scenario-replay-offline-enforcement-replay
    
    Write-Host "`n✅ Done! Check your PR:" -ForegroundColor Green
    Write-Host "https://github.com/abbaskachia/stellar-agent-guard-sdk/pulls" -ForegroundColor Blue
} else {
    Write-Host "`nSkipped push. You can manually commit and push when ready." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Commands to run manually:" -ForegroundColor Cyan
    Write-Host "  git add tests/unit/replay.test.ts" -ForegroundColor Gray
    Write-Host "  git commit -m 'fix: correct GuardEvent property access'" -ForegroundColor Gray
    Write-Host "  git push origin feat(test)/fixture-driven-live-scenario-replay-offline-enforcement-replay" -ForegroundColor Gray
}
