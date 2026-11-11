const names: Record<string, string> = {
  EXCHANGEARCHIVE_ADDON: 'Exchange Online Archiving for Exchange Online',
  SPB: 'Business Premium', O365_BUSINESS_PREMIUM: 'Business Standard',
  O365_BUSINESS_ESSENTIALS: 'Business Basic', EXCHANGESTANDARD: 'Exchange Online Plan 1',
  EXCHANGEENTERPRISE: 'Exchange Online Plan 2', ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5', SPE_E3: 'Microsoft 365 E3', SPE_E5: 'Microsoft 365 E5',
  FLOW_FREE: 'Power Automate Free', POWER_BI_STANDARD: 'Power BI Free',
};

export function microsoftSkuName(partNumber: string): string {
  return names[partNumber] ?? partNumber.replaceAll('_', ' ');
}
