export function ErrorState({ message }: { message: string }) {
  return (
    <div className="mb-4 px-4 py-3 rounded-btn text-sm text-red-700 bg-red-50 border border-red-200">
      {message}
    </div>
  );
}

