import { reactive } from "vue";

export const viewState = reactive({
  dirty: false,
  status: "idle",
});
