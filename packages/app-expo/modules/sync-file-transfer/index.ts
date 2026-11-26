import { requireOptionalNativeModule } from "expo";

type UploadResponse = {
  status: number;
  url: string;
  location: string;
  contentType: string;
  prefix: number[];
};

type SyncFileTransfer = {
  addListener(
    eventName: "uploadProgress",
    listener: (event: { id: string; loaded: number; total: number }) => void,
  ): { remove(): void };
  replace(source: string, destination: string): Promise<void>;
  upload(
    url: string,
    fileUri: string,
    headers: Record<string, string>,
    id: string,
  ): Promise<UploadResponse>;
};

export default requireOptionalNativeModule<SyncFileTransfer>("SyncFileTransfer");
