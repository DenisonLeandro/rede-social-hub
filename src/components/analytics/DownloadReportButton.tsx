import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { downloadAnalyticsReportPdf } from "@/lib/analytics-report";
import type { ReportInsights, ReportProfile } from "@/components/analytics/AnalyticsReportDocument";

interface Props {
  profiles: ReportProfile[];
  insights: ReportInsights;
  aiAnswer?: string;
  className?: string;
}

/** Baixa o relatório completo (métricas + diagnóstico IA + insights) em PDF. */
export function DownloadReportButton({ profiles, insights, aiAnswer, className }: Props) {
  const { toast } = useToast();
  const { activeCompany } = useCompany();
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (!profiles.length) {
      toast({ title: "Sem dados", description: "Colete os analytics antes de gerar o PDF.", variant: "destructive" });
      return;
    }
    setLoading(true);
    toast({ title: "Gerando PDF…", description: "Isso leva alguns segundos." });
    try {
      await downloadAnalyticsReportPdf({
        companyName: activeCompany?.name || "Minha empresa",
        generatedAt: new Date(),
        profiles,
        insights,
        aiAnswer,
      });
      toast({ title: "PDF gerado!", description: "O download começou." });
    } catch (err) {
      toast({
        title: "Erro ao gerar PDF",
        description: err instanceof Error ? err.message : "Erro desconhecido",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={loading} className={className}>
      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
      Baixar PDF
    </Button>
  );
}

export default DownloadReportButton;
