$manifest = Get-Content -Path manifest.json -Raw | ConvertFrom-Json
if ($null -ne $manifest.version) {
	[string]$manifest.version
}