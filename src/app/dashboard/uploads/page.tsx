import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function UploadsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Uploads</h1>
        <p className="text-sm text-slate-500 mt-1">CSV / XLSX bulk data ingestion.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Coming in Phase 2</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Tolerant CSV / XLSX upload with header aliasing, fuzzy employee matching,
            and a preview-and-confirm flow. Lands in Phase 2.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
