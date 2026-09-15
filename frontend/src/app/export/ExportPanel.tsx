import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n";

export default function ExportPanel({
  reportText,
  onCopy,
  onDownload,
}: {
  reportText: string;
  onCopy: () => void;
  onDownload: () => void;
}) {
  const { tl } = useI18n();
  return (
    <div className="glass flex h-full flex-col rounded-2xl p-6 shadow-glass">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-frost/50">{tl("export_report")}</div>
          <div className="text-2xl font-semibold">{tl("final_report_of_the_lesson")}</div>
        </div>
        <Badge>Export</Badge>
      </div>
      <textarea
        readOnly
        value={reportText}
        className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-frost/80"
      />
      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={onCopy}>
          {tl("copy")}
        </Button>
        <Button variant="accent" onClick={onDownload}>
          {tl("download_txt")}
        </Button>
      </div>
    </div>
  );
}
