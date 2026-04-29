import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ReportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-slate-500 mt-1">Generated employee performance reports.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Coming in Phase 4</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            Report generation, archive, and download will land in Phase 4.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
