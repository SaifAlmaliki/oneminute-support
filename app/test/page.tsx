import React from "react";
import Script from "next/script";

const Page = () => {
  return (
    <div>
      <Script
        src="https://oneminute-support.vercel.app/widget.js"
        data-id="a6afa329-a3c5-4104-b71b-e23717929846"
        defer
      ></Script>
    </div>
  );
};

export default Page;
